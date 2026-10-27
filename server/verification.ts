import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { sendMail, mailConfigured } from './email.js';
import { env } from './env.js';

const TTL_MS = 24 * 3_600_000;
const RESEND_COOLDOWN_MS = 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export type SendResult = 'sent' | 'not_configured' | 'throttled' | 'already_verified' | 'no_email' | 'failed';

/** Emails a one-time link proving the user controls their address. Only a hash of the token is stored. */
export async function sendVerification(userId: string): Promise<SendResult> {
  const u = (await db.execute({ sql: 'SELECT email, email_verified FROM users WHERE id = ?', args: [userId] })).rows[0] as unknown as
    | { email: string | null; email_verified: number }
    | undefined;
  if (!u?.email) return 'no_email';
  if (u.email_verified) return 'already_verified';

  const last = (await db.execute({ sql: 'SELECT MAX(created_at) AS t FROM email_verifications WHERE user_id = ?', args: [userId] })).rows[0] as unknown as { t: number | null };
  if (last.t && Date.now() - last.t < RESEND_COOLDOWN_MS) return 'throttled';

  const token = randomBytes(32).toString('base64url');
  await db.execute({
    sql: 'INSERT INTO email_verifications (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [hash(token), userId, u.email.toLowerCase(), Date.now(), Date.now() + TTL_MS],
  });
  const sent = await sendMail(
    u.email,
    'Confirm your email for Lojubets',
    `Confirm this is your email address by opening this link (valid for 24 hours):\n\n${env.appUrl}/verify-email?token=${token}\n\nIf you didn't create a Lojubets account, ignore this message.`,
  );
  if (sent) return 'sent';
  return mailConfigured() ? 'failed' : 'not_configured';
}

/** Marks the address verified if the token is valid and the account's email hasn't changed since. */
export async function consumeVerification(token: string): Promise<boolean> {
  const row = (await db.execute({ sql: 'SELECT user_id, email, expires_at FROM email_verifications WHERE token_hash = ?', args: [hash(token)] })).rows[0] as unknown as
    | { user_id: string; email: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return false;
  await db.batch(
    [
      { sql: 'UPDATE users SET email_verified = 1 WHERE id = ? AND lower(email) = ?', args: [row.user_id, row.email] },
      { sql: 'DELETE FROM email_verifications WHERE user_id = ?', args: [row.user_id] },
    ],
    'write',
  );
  return true;
}
