import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mails: { to: string; subject: string; text: string }[] = [];
vi.mock('./email.js', () => ({
  mailConfigured: () => true,
  sendMail: async (to: string, subject: string, text: string) => (mails.push({ to, subject, text }), true),
  sendInviteEmail: async () => false,
}));
import app from './app.js';
import { db } from './db.js';

beforeEach(async () => {
  mails.length = 0;
  await db.execute('DELETE FROM rate_limits').catch(() => undefined);
  await db.execute('DELETE FROM password_resets').catch(() => undefined);
});

let n = 0;
const register = async (password = 'correct horse') => {
  const email = `reset${n++}@example.com`;
  const a = request.agent(app);
  await a.post('/api/auth/register').send({ email, password }).expect(201);
  mails.length = 0;
  return { a, email };
};
const tokenIn = (m: { text: string }) => m.text.match(/reset-password\?token=([\w-]+)/)![1];
const forgot = (email: string) => request(app).post('/api/auth/forgot-password').send({ email });

describe('password reset', () => {
  it('emails a link that sets a new password, signs out every session and verifies the address', async () => {
    const { a, email } = await register();
    await a.get('/api/me').expect(200);

    await forgot(email).expect(200);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(email);
    const token = tokenIn(mails[0]);

    await request(app).post('/api/auth/reset-password').send({ token, password: 'a brand new one' }).expect(200);

    await a.get('/api/me').expect(401); // the old session died with the old password
    await request(app).post('/api/auth/login').send({ email, password: 'correct horse' }).expect(401);
    const fresh = request.agent(app);
    await fresh.post('/api/auth/login').send({ email, password: 'a brand new one' }).expect(200);
    expect((await fresh.get('/api/me')).body.emailVerified).toBe(true); // opening the mailed link proved the mailbox
  });

  it('on a merged account, sets the password for every email, not just the one the link went to', async () => {
    const one = await register();
    const two = await register();
    // merging needs both addresses verified
    for (const e of [one.email, two.email]) {
      await db.execute({ sql: 'UPDATE user_emails SET verified = 1 WHERE email = ?', args: [e] });
      await db.execute({ sql: 'UPDATE users SET email_verified = 1 WHERE lower(email) = ?', args: [e] });
    }
    await one.a.post('/api/merge/password').send({ email: two.email, password: 'correct horse' }).expect(200);
    await one.a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none', newPassword: 'merged passphrase' }).expect(200);

    await forgot(two.email).expect(200);
    await request(app).post('/api/auth/reset-password').send({ token: tokenIn(mails[0]), password: 'a brand new one' }).expect(200);

    for (const email of [one.email, two.email]) {
      await request(app).post('/api/auth/login').send({ email, password: 'merged passphrase' }).expect(401);
      await request(app).post('/api/auth/login').send({ email, password: 'a brand new one' }).expect(200);
    }
  });

  it('does not verify an address that another account has verified in the meantime', async () => {
    const { email } = await register(); // a password account on an unverified address
    const squatter = (await db.execute({ sql: 'SELECT user_id FROM user_emails WHERE email = ?', args: [email] })).rows[0].user_id;
    // the real owner signs up another way and verifies the same address on a separate account
    await db.execute({ sql: `INSERT INTO users (id, email, email_verified, name, created_at) VALUES ('owner-x', ?, 1, '', 1)`, args: [email] });
    await db.execute({ sql: 'INSERT INTO user_emails (user_id, email, verified, created_at) VALUES (?, ?, 1, 1)', args: ['owner-x', email] });

    await forgot(email).expect(200);
    await request(app).post('/api/auth/reset-password').send({ token: tokenIn(mails[0]), password: 'a brand new one' }).expect(200);
    const verified = (await db.execute({ sql: 'SELECT user_id FROM user_emails WHERE email = ? AND verified = 1', args: [email] })).rows.map((r) => r.user_id);
    expect(verified).toEqual(['owner-x']); // still one account per verified address
    expect(verified).not.toContain(squatter);
    await request(app).post('/api/auth/login').send({ email, password: 'a brand new one' }).expect(200); // the password did change
  });

  it('works once only', async () => {
    const { email } = await register();
    await forgot(email).expect(200);
    const token = tokenIn(mails[0]);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'first new one' }).expect(200);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'second new one' }).expect(400);
    await request(app).post('/api/auth/login').send({ email, password: 'first new one' }).expect(200);
  });

  it('voids older links when a password is reset', async () => {
    const { email } = await register();
    await forgot(email).expect(200);
    const older = tokenIn(mails[0]);
    await db.execute('UPDATE password_resets SET created_at = created_at - 120000'); // past the one-minute cooldown
    await forgot(email).expect(200);
    const newer = tokenIn(mails[1]);
    await request(app).post('/api/auth/reset-password').send({ token: newer, password: 'chosen password' }).expect(200);
    await request(app).post('/api/auth/reset-password').send({ token: older, password: 'other password' }).expect(400);
  });

  it('rejects an expired or made-up token, and a too-short password', async () => {
    const { email } = await register();
    await forgot(email).expect(200);
    const token = tokenIn(mails[0]);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'short' }).expect(400);
    await request(app).post('/api/auth/reset-password').send({ token: 'not-a-token', password: 'long enough password' }).expect(400);
    await db.execute('UPDATE password_resets SET expires_at = 1');
    await request(app).post('/api/auth/reset-password').send({ token, password: 'long enough password' }).expect(400);
    await request(app).post('/api/auth/login').send({ email, password: 'correct horse' }).expect(200); // unchanged
  });

  it("answers the same, and sends nothing, for an address that has no password login", async () => {
    const known = await register();
    const asKnown = await forgot(known.email).expect(200);
    mails.length = 0;
    const asUnknown = await forgot('nobody@example.com').expect(200);
    expect(asUnknown.body).toEqual(asKnown.body);
    expect(mails).toHaveLength(0);

    // a sign-in-provider account with that address has no password to reset either
    await request.agent(app).post('/api/auth/dev').send({ name: 'Dev', email: 'devonly@example.com' }).expect(200);
    await forgot('devonly@example.com').expect(200);
    expect(mails).toHaveLength(0);
  });

  it('stores only a hash of the token, and holds back repeat requests for a minute', async () => {
    const { email } = await register();
    await forgot(email).expect(200);
    await forgot(email).expect(200);
    expect(mails).toHaveLength(1);
    const token = tokenIn(mails[0]);
    const rows = JSON.stringify((await db.execute('SELECT * FROM password_resets')).rows);
    expect(rows).not.toContain(token);
  });

  it('throttles requests per address', async () => {
    const { email } = await register();
    for (let i = 0; i < 5; i++) await forgot(email).expect(200);
    await forgot(email).expect(429);
  });

  it('does not accept a reset token as a session or a verification token', async () => {
    const { email } = await register();
    await forgot(email).expect(200);
    const token = tokenIn(mails[0]);
    await request(app).get('/api/me').set('Cookie', `session=${token}`).expect(401);
    await request(app).post('/api/auth/verify-email').send({ token }).expect(400);
  });
});
