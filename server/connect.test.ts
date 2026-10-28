import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({ publicKey: undefined as unknown as CryptoKey }));
vi.mock('jose', async (importOriginal) => ({ ...(await importOriginal<typeof import('jose')>()), createRemoteJWKSet: () => async () => keys.publicKey }));
const mails: { to: string; text: string }[] = [];
vi.mock('./email.js', () => ({
  mailConfigured: () => true,
  sendMail: async (to: string, _s: string, text: string) => (mails.push({ to, text }), true),
  sendInviteEmail: async () => false,
}));

import { SignJWT, generateKeyPair } from 'jose';
import app from './app.js';
import { db } from './db.js';

const CLIENT_ID = 'ms-client';
const TENANT = '11111111-1111-4111-8111-111111111111';
const iss = `https://login.microsoftonline.com/${TENANT}/v2.0`;

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys.publicKey = pair.publicKey;
});
beforeEach(async () => {
  process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = 'secret';
  mails.length = 0;
  await db.execute('DELETE FROM rate_limits').catch(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
});

let n = 0;
const devUser = async (email = `conn${n++}@example.com`) => {
  const a = request.agent(app);
  await a.post('/api/auth/dev').send({ name: 'Conn', email }).expect(200);
  return { a, email, id: (await a.get('/api/me')).body.id as string };
};

/** Starts a Microsoft flow with the given query on this browser, then completes it with a locally signed ID token. */
async function microsoft(agent: ReturnType<typeof request.agent>, query: string, claims: Record<string, unknown>) {
  const start = await agent.get(`/api/auth/microsoft?${query}`).expect(302);
  if (!start.headers.location.startsWith('https://login.microsoftonline.com')) return { location: start.headers.location as string, started: false };
  const url = new URL(start.headers.location);
  const idToken = await new SignJWT({ nonce: url.searchParams.get('nonce'), email: `ms${n++}@example.com`, tid: TENANT, ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(iss)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  const done = await agent.get(`/api/auth/microsoft/callback?code=c&state=${url.searchParams.get('state')}`).expect(302);
  return { location: done.headers.location as string, started: true };
}
const logins = async (a: ReturnType<typeof request.agent>) => (await a.get('/api/me')).body.logins as { provider: string; account: string | null }[];
const userCount = async () => Number((await db.execute('SELECT COUNT(*) AS c FROM users')).rows[0].c);

describe('connecting another sign-in', () => {
  it('adds a Microsoft login to the signed-in account, which then signs in to it', async () => {
    const u = await devUser();
    await u.a.post('/api/me/connect').send({}).expect(200);
    const r = await microsoft(u.a, 'connect=1', { sub: 'conn-sub', email: 'work@contoso.example' });
    expect(r.location).toBe('http://localhost:5173/profile?connected=1');
    const ms = (await logins(u.a)).filter((l) => l.provider === 'microsoft');
    expect(ms.map((l) => l.account)).toEqual(['work@contoso.example']);

    const again = request.agent(app); // a fresh browser signs in with Microsoft alone
    await microsoft(again, 'next=/', { sub: 'conn-sub', email: 'work@contoso.example' });
    expect((await again.get('/api/me')).body.id).toBe(u.id);
  });

  it('needs the ticket from a fresh proof, and spends it', async () => {
    const u = await devUser();
    const without = await microsoft(u.a, 'connect=1', { sub: 'no-ticket' });
    expect(without.started).toBe(false);
    expect(without.location).toContain('/profile?error=');

    await u.a.post('/api/me/connect').send({}).expect(200);
    await microsoft(u.a, 'connect=1', { sub: 'once' });
    const reused = await microsoft(u.a, 'connect=1', { sub: 'twice' }); // the ticket was spent by the first start
    expect(reused.started).toBe(false);
    expect((await logins(u.a)).filter((l) => l.provider === 'microsoft')).toHaveLength(1);
  });

  it('refuses an old sign-in for a provider-only account, and asks a password account for its password', async () => {
    const { SignJWT: Sign } = await import('jose');
    const u = await devUser();
    const now = Math.floor(Date.now() / 1000);
    const old = await new Sign({ typ: 'session', ver: 0, auth: now - 3600 }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuedAt(now).setExpirationTime(now + 3600).sign(new TextEncoder().encode('test-secret'));
    const res = await request(app).post('/api/me/connect').set('Cookie', `session=${old}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('reauth_required');

    const pw = request.agent(app);
    await pw.post('/api/auth/register').send({ email: 'connpw@example.com', password: 'correct horse' }).expect(201);
    await pw.post('/api/me/connect').send({ password: 'wrong' }).expect(401);
    await pw.post('/api/me/connect').send({ password: 'correct horse' }).expect(200);
  });

  it("never takes over a sign-in that belongs to another account", async () => {
    const owner = await devUser();
    await owner.a.post('/api/me/connect').send({}).expect(200);
    await microsoft(owner.a, 'connect=1', { sub: 'taken' });

    const other = await devUser();
    await other.a.post('/api/me/connect').send({}).expect(200);
    const r = await microsoft(other.a, 'connect=1', { sub: 'taken' });
    expect(r.location).toContain('error=');
    expect(decodeURIComponent(r.location)).toContain('already belongs to another');
    expect((await logins(other.a)).filter((l) => l.provider === 'microsoft')).toHaveLength(0);
  });

  it('lets one account hold several accounts of the same provider', async () => {
    const u = await devUser();
    for (const sub of ['first', 'second']) {
      await u.a.post('/api/me/connect').send({}).expect(200);
      await microsoft(u.a, 'connect=1', { sub });
    }
    expect((await logins(u.a)).filter((l) => l.provider === 'microsoft')).toHaveLength(2);
  });
});

describe('an email another account has already verified', () => {
  it('does not create a second, unusable account when Microsoft shares it', async () => {
    const u = await devUser('lasse@example.com');
    const before = await userCount();
    const browser = request.agent(app);
    const r = await microsoft(browser, 'next=/', { sub: 'clash', email: 'lasse@example.com' });
    expect(r.location).toContain('/login?error=');
    expect(decodeURIComponent(r.location)).toContain('connect Microsoft from your profile');
    expect(await userCount()).toBe(before);
    await browser.get('/api/me').expect(401);
    expect(mails).toHaveLength(0); // no confirmation mail for an account that was never made
    // the original account is untouched
    expect((await u.a.get('/api/me')).body.id).toBe(u.id);
  });

  it('still creates an account when nobody has verified the address', async () => {
    const browser = request.agent(app);
    const r = await microsoft(browser, 'next=/', { sub: 'fresh', email: 'brand-new@example.com' });
    expect(r.location).toBe('http://localhost:5173/');
    await browser.get('/api/me').expect(200);
  });

  it('does not register a password account on it either', async () => {
    await devUser('taken@example.com');
    const res = await request(app).post('/api/auth/register').send({ email: 'taken@example.com', password: 'correct horse' });
    expect(res.status).toBe(409);
  });
});
