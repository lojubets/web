import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from './auth.js';
import { db } from './db.js';
import { sendMail } from './email.js';
import { env } from './env.js';
import { rateLimit } from './rateLimit.js';

const TTL_MS = 60 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Emails a one-time link to the address a password login was registered with. Only a hash of the token is stored.
 * Does nothing if there is no such password login or one was sent in the last minute; the caller can't tell the difference.
 */
async function sendReset(email: string): Promise<void> {
  const login = await db.execute({ sql: `SELECT 1 FROM identities WHERE provider = 'password' AND subject = ?`, args: [email] });
  if (!login.rows.length) return;
  const last = (await db.execute({ sql: 'SELECT MAX(created_at) AS t FROM password_resets WHERE subject = ?', args: [email] })).rows[0] as unknown as { t: number | null };
  if (last.t && Date.now() - last.t < RESEND_COOLDOWN_MS) return;

  const token = randomBytes(32).toString('base64url');
  await db.execute({
    sql: 'INSERT INTO password_resets (token_hash, subject, created_at, expires_at) VALUES (?, ?, ?, ?)',
    args: [hash(token), email, Date.now(), Date.now() + TTL_MS],
  });
  await sendMail(
    email,
    'Reset your LoJuBets password',
    `Choose a new password by opening this link (valid for one hour):\n\n${env.appUrl}/reset-password?token=${token}\n\nIf you didn't ask for this, ignore this message: your password stays as it is.`,
  );
}

/**
 * Sets a new password if the token is valid. Whoever opened the link controls the mailbox, so that address counts as
 * verified, every existing session of the account is signed out, and every other pending link is void.
 */
async function consumeReset(token: string, password: string): Promise<boolean> {
  const row = (await db.execute({ sql: 'SELECT subject, expires_at FROM password_resets WHERE token_hash = ?', args: [hash(token)] })).rows[0] as unknown as
    | { subject: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) return false;
  const owner = (await db.execute({ sql: `SELECT user_id FROM identities WHERE provider = 'password' AND subject = ?`, args: [row.subject] })).rows[0] as unknown as
    | { user_id: string }
    | undefined;
  if (!owner) return false;
  await db.batch(
    [
      { sql: 'UPDATE password_credentials SET password_hash = ? WHERE subject = ?', args: [await hashPassword(password), row.subject] },
      { sql: 'UPDATE users SET email_verified = 1 WHERE id = ? AND lower(email) = ?', args: [owner.user_id, row.subject] },
      { sql: 'UPDATE user_emails SET verified = 1 WHERE user_id = ? AND email = ?', args: [owner.user_id, row.subject] },
      { sql: 'UPDATE users SET session_version = session_version + 1 WHERE id = ?', args: [owner.user_id] },
      { sql: 'DELETE FROM password_resets WHERE subject = ?', args: [row.subject] },
    ],
    'write',
  );
  return true;
}

export const passwordResetRouter = Router();

// Same answer whether or not the address has an account, so this can't be used to find out who is registered.
passwordResetRouter.post('/forgot-password', rateLimit('reset-request', { perIp: 20, perBody: { field: 'email', max: 5 } }), async (req, res) => {
  const body = z.object({ email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email address' });
  await sendReset(body.data.email.trim().toLowerCase());
  res.json({ ok: true });
});

passwordResetRouter.post('/reset-password', rateLimit('reset', { perIp: 30 }), async (req, res) => {
  const body = z.object({ token: z.string().min(1).max(200), password: z.string().min(8).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Choose a password of at least 8 characters' });
  if (!(await consumeReset(body.data.token, body.data.password))) return res.status(400).json({ error: 'This link is invalid or has expired. Ask for a new one.' });
  res.json({ ok: true });
});
