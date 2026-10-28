import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { sendMail, mailConfigured } from './email.js';
import { env } from './env.js';

const TTL_MS = 24 * 3_600_000;
const RESEND_COOLDOWN_MS = 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export type SendResult = 'sent' | 'not_configured' | 'throttled' | 'already_verified' | 'no_email' | 'failed';

/**
 * Emails a one-time link proving the user controls an address of theirs (the primary one unless `email` is given).
 * Only a hash of the token is stored.
 */
export async function sendVerification(userId: string, email?: string): Promise<SendResult> {
  const u = (await db.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [userId] })).rows[0] as unknown as { email: string | null } | undefined;
  const address = (email ?? u?.email)?.trim().toLowerCase();
  if (!address) return 'no_email';
  const own = (await db.execute({ sql: 'SELECT verified FROM user_emails WHERE user_id = ? AND email = ?', args: [userId, address] })).rows[0] as unknown as { verified: number } | undefined;
  if (!own) return 'no_email';
  if (own.verified) return 'already_verified';

  const last = (await db.execute({ sql: 'SELECT MAX(created_at) AS t FROM email_verifications WHERE user_id = ? AND email = ?', args: [userId, address] })).rows[0] as unknown as { t: number | null };
  if (last.t && Date.now() - last.t < RESEND_COOLDOWN_MS) return 'throttled';

  const token = randomBytes(32).toString('base64url');
  await db.execute({
    sql: 'INSERT INTO email_verifications (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    args: [hash(token), userId, address, Date.now(), Date.now() + TTL_MS],
  });
  const sent = await sendMail(
    address,
    'Confirm your email for LoJuBets',
    `Confirm this is your email address by opening this link (valid for 24 hours):\n\n${env.appUrl}/verify-email?token=${token}\n\nIf you didn't ask for this, ignore this message.`,
  );
  if (sent) return 'sent';
  return mailConfigured() ? 'failed' : 'not_configured';
}

/**
 * Marks the address verified if the token is valid, the address is still on the account, and no other account has
 * verified it in the meantime (a verified address identifies one account only).
 */
export async function consumeVerification(token: string): Promise<boolean> {
  const row = (await db.execute({ sql: 'SELECT user_id, email, expires_at FROM email_verifications WHERE token_hash = ?', args: [hash(token)] })).rows[0] as unknown as
    | { user_id: string; email: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return false;
  const takenElsewhere = (await db.execute({ sql: 'SELECT 1 FROM user_emails WHERE email = ? AND verified = 1 AND user_id != ?', args: [row.email, row.user_id] })).rows.length > 0;
  if (takenElsewhere) {
    await db.execute({ sql: 'DELETE FROM email_verifications WHERE token_hash = ?', args: [hash(token)] });
    return false;
  }
  await db.batch(
    [
      { sql: 'UPDATE users SET email_verified = 1 WHERE id = ? AND lower(email) = ?', args: [row.user_id, row.email] },
      { sql: 'UPDATE user_emails SET verified = 1 WHERE user_id = ? AND email = ?', args: [row.user_id, row.email] },
      // Only this address's links: other addresses may be waiting for theirs
      { sql: 'DELETE FROM email_verifications WHERE user_id = ? AND email = ?', args: [row.user_id, row.email] },
    ],
    'write',
  );
  return true;
}
