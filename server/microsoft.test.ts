import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({ publicKey: undefined as unknown as CryptoKey }));
vi.mock('jose', async (importOriginal) => ({ ...(await importOriginal<typeof import('jose')>()), createRemoteJWKSet: () => async () => keys.publicKey }));
vi.mock('./email.js', () => ({ mailConfigured: () => true, sendMail: async () => true, sendInviteEmail: async () => false }));

import { SignJWT, generateKeyPair } from 'jose';
import app from './app.js';
import { checkMicrosoftClaims, microsoftSubject } from './auth.js';
import { db } from './db.js';

const CLIENT_ID = 'ms-client';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CONSUMERS = '9188040d-6c67-4c5c-b112-d4b9e8fb6d5f';
const iss = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keys.publicKey = pair.publicKey;
});
beforeEach(async () => {
  process.env.MICROSOFT_CLIENT_ID = CLIENT_ID;
  process.env.MICROSOFT_CLIENT_SECRET = 'secret';
  delete process.env.MICROSOFT_TENANT;
  await db.execute('DELETE FROM rate_limits').catch(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  delete process.env.MICROSOFT_TENANT;
});

describe('Microsoft ID token checks', () => {
  it('wants the issuer to belong to the token\'s own tenant', () => {
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_A) }, 'common')).not.toThrow();
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_B) }, 'common')).toThrow();
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: 'https://evil.example/v2.0' }, 'common')).toThrow();
    expect(() => checkMicrosoftClaims({ iss: iss(TENANT_A) }, 'common')).toThrow(); // no tenant at all
    expect(() => checkMicrosoftClaims({ tid: 'not-a-guid', iss: iss('not-a-guid') }, 'common')).toThrow();
  });

  it('pins the tenant when one is configured', () => {
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_A) }, TENANT_A.toUpperCase())).not.toThrow();
    expect(() => checkMicrosoftClaims({ tid: TENANT_B, iss: iss(TENANT_B) }, TENANT_A)).toThrow();
    expect(() => checkMicrosoftClaims({ tid: CONSUMERS, iss: iss(CONSUMERS) }, 'consumers')).not.toThrow();
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_A) }, 'consumers')).toThrow();
    expect(() => checkMicrosoftClaims({ tid: CONSUMERS, iss: iss(CONSUMERS) }, 'organizations')).toThrow();
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_A) }, 'organizations')).not.toThrow();
    // a tenant given as a domain name can't be compared to the tid, so only the issuer is checked
    expect(() => checkMicrosoftClaims({ tid: TENANT_A, iss: iss(TENANT_A) }, 'contoso.onmicrosoft.com')).not.toThrow();
  });

  it('keys an identity on tenant and sub', () => {
    expect(microsoftSubject({ tid: TENANT_A.toUpperCase(), sub: 'abc' })).toBe(`${TENANT_A}:abc`);
  });
});

let n = 0;
/** Runs a whole Microsoft sign-in with a locally signed ID token. Resolves to where the callback redirected, plus the agent. */
async function signIn(claims: Record<string, unknown>) {
  const agent = request.agent(app);
  const start = await agent.get('/api/auth/microsoft?next=/').expect(302);
  const url = new URL(start.headers.location);
  const state = url.searchParams.get('state')!;
  const nonce = url.searchParams.get('nonce')!;
  const idToken = await new SignJWT({ nonce, email: `ms${n++}@example.com`, name: 'Ms User', ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  const done = await agent.get(`/api/auth/microsoft/callback?code=c&state=${state}`).expect(302);
  return { location: done.headers.location as string, agent };
}
const subjects = async () => (await db.execute(`SELECT subject FROM identities WHERE provider = 'microsoft'`)).rows.map((r) => String(r.subject));

describe('signing in with Microsoft', () => {
  it('accepts a token whose issuer matches its tenant, and stores the tenant with the sub', async () => {
    const { location, agent } = await signIn({ sub: 'sub-ok', tid: TENANT_A, iss: iss(TENANT_A) });
    expect(location).toBe('http://localhost:5173/');
    await agent.get('/api/me').expect(200);
    expect(await subjects()).toContain(`${TENANT_A}:sub-ok`);
  });

  it('refuses a token whose issuer is not its tenant\'s', async () => {
    const { location, agent } = await signIn({ sub: 'sub-bad', tid: TENANT_A, iss: iss(TENANT_B) });
    expect(location).toContain('/login?error=');
    await agent.get('/api/me').expect(401);
    expect(await subjects()).not.toContain(`${TENANT_A}:sub-bad`);
  });

  it('refuses a token from another tenant than the configured one', async () => {
    process.env.MICROSOFT_TENANT = TENANT_A;
    const { location, agent } = await signIn({ sub: 'sub-other', tid: TENANT_B, iss: iss(TENANT_B) });
    expect(location).toContain('/login?error=');
    await agent.get('/api/me').expect(401);
  });

  it('treats the same sub in two tenants as two people', async () => {
    const a = await signIn({ sub: 'same-sub', tid: TENANT_A, iss: iss(TENANT_A) });
    const b = await signIn({ sub: 'same-sub', tid: TENANT_B, iss: iss(TENANT_B) });
    expect((await a.agent.get('/api/me')).body.id).not.toBe((await b.agent.get('/api/me')).body.id);
  });

  it('moves an identity stored under the bare sub to the tenant-qualified key on its next sign-in', async () => {
    const dev = request.agent(app);
    await dev.post('/api/auth/dev').send({ name: 'Old', email: 'legacy-ms@example.com' }).expect(200);
    const id = (await dev.get('/api/me')).body.id as string;
    await db.execute({ sql: `INSERT INTO identities (provider, subject, user_id) VALUES ('microsoft', 'legacy-sub', ?)`, args: [id] });

    const { agent } = await signIn({ sub: 'legacy-sub', tid: TENANT_A, iss: iss(TENANT_A) });
    expect((await agent.get('/api/me')).body.id).toBe(id); // the same account, not a new one
    const mine = (await db.execute({ sql: `SELECT subject FROM identities WHERE provider = 'microsoft' AND user_id = ?`, args: [id] })).rows.map((r) => String(r.subject));
    expect(mine).toEqual([`${TENANT_A}:legacy-sub`]);
  });
});
