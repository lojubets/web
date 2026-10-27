import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify, createRemoteJWKSet, importPKCS8, type JWTPayload } from 'jose';
import { z } from 'zod';
import { db } from './db.js';
import { env } from './env.js';
import { consumeVerification, sendVerification } from './verification.js';

type ProviderId = 'google' | 'microsoft' | 'apple';

interface Provider {
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuer?: string;
  scope: string;
  extraParams?: Record<string, string>;
  clientId: string;
  clientSecret: () => Promise<string>;
  /** Whether the provider's email claim can be trusted to link/match accounts. */
  trustsEmail: (claims: JWTPayload) => boolean;
}

function providers(): Partial<Record<ProviderId, Provider>> {
  const out: Partial<Record<ProviderId, Provider>> = {};
  const e = process.env;
  if (e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) {
    out.google = {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      issuer: 'https://accounts.google.com',
      scope: 'openid email profile',
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: async () => e.GOOGLE_CLIENT_SECRET!,
      trustsEmail: (c) => c.email_verified === true,
    };
  }
  if (e.MICROSOFT_CLIENT_ID && e.MICROSOFT_CLIENT_SECRET) {
    const tenant = e.MICROSOFT_TENANT || 'common';
    out.microsoft = {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      jwksUrl: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      scope: 'openid email profile',
      clientId: e.MICROSOFT_CLIENT_ID,
      clientSecret: async () => e.MICROSOFT_CLIENT_SECRET!,
      // Microsoft's email claim is not verified (nOAuth), so never link/match on it.
      trustsEmail: () => false,
    };
  }
  if (e.APPLE_CLIENT_ID && e.APPLE_TEAM_ID && e.APPLE_KEY_ID && e.APPLE_PRIVATE_KEY) {
    const { APPLE_CLIENT_ID: clientId, APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId } = e;
    out.apple = {
      authorizeUrl: 'https://appleid.apple.com/auth/authorize',
      tokenUrl: 'https://appleid.apple.com/auth/token',
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      issuer: 'https://appleid.apple.com',
      scope: 'name email',
      extraParams: { response_mode: 'form_post' },
      clientId,
      // Apple wants a short-lived JWT signed with your private key as the client secret.
      clientSecret: async () => {
        const key = await importPKCS8(e.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
        return new SignJWT({})
          .setProtectedHeader({ alg: 'ES256', kid: keyId })
          .setIssuer(teamId)
          .setSubject(clientId)
          .setAudience('https://appleid.apple.com')
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(key);
      },
      trustsEmail: (c) => c.email_verified === true || c.email_verified === 'true',
    };
  }
  return out;
}

export function enabledProviders(): ProviderId[] {
  return Object.keys(providers()) as ProviderId[];
}

// ---------- sessions ----------

const secret = new TextEncoder().encode(env.sessionSecret);
const SESSION_DAYS = 30;

const cookieBase = { httpOnly: true, secure: env.isProd, path: '/' } as const;

async function startSession(res: Response, userId: string) {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret);
  res.cookie('session', token, { ...cookieBase, sameSite: 'lax', maxAge: SESSION_DAYS * 86_400_000 });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.session;
    if (!token) throw new Error('no session');
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const user = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [payload.sub!] });
    if (!user.rows.length) throw new Error('unknown user');
    res.locals.userId = payload.sub as string;
    next();
  } catch {
    res.status(401).json({ error: 'Not signed in' });
  }
}

// ---------- users ----------

async function findOrCreateUser(opts: {
  provider: string;
  subject: string;
  email?: string | null;
  emailVerified: boolean;
  name?: string | null;
  linkByEmail: boolean;
}): Promise<{ userId: string; created: boolean }> {
  const existing = await db.execute({
    sql: 'SELECT user_id FROM identities WHERE provider = ? AND subject = ?',
    args: [opts.provider, opts.subject],
  });
  if (existing.rows.length) return { userId: existing.rows[0].user_id as string, created: false };

  let userId: string | undefined;
  let created = false;
  if (opts.linkByEmail && opts.email && opts.emailVerified) {
    const byEmail = await db.execute({
      sql: 'SELECT id FROM users WHERE lower(email) = lower(?) AND email_verified = 1',
      args: [opts.email],
    });
    if (byEmail.rows.length) userId = byEmail.rows[0].id as string;
  }
  if (!userId) {
    userId = randomUUID();
    created = true;
    // No name from the provider means no display name: the user is shown by their email until they set one.
    const name = opts.name?.trim() || '';
    await db.execute({
      sql: 'INSERT INTO users (id, email, email_verified, name, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [userId, opts.email ?? null, opts.emailVerified ? 1 : 0, name, Date.now()],
    });
  }
  await db.execute({
    sql: 'INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)',
    args: [opts.provider, opts.subject, userId],
  });
  return { userId, created };
}

// ---------- passwords ----------

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${(await scryptAsync(pw, salt, 64)).toString('hex')}`;
}

async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  return timingSafeEqual(await scryptAsync(pw, Buffer.from(salt, 'hex'), expected.length), expected);
}

// Compared against when the email is unknown, so timing doesn't reveal which emails exist.
const dummyHash = hashPassword('not-a-real-password');

// ---------- routes ----------

function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const authRouter = Router();


authRouter.post('/dev', async (req, res) => {
  if (!env.devLogin) return res.status(404).json({ error: 'Not found' });
  const body = z.object({ name: z.string().default(''), email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'name and email required' });
  const { name, email } = body.data;
  const { userId } = await findOrCreateUser({
    provider: 'dev',
    subject: email.toLowerCase(),
    email,
    emailVerified: true,
    name,
    linkByEmail: true,
  });
  await startSession(res, userId);
  res.json({ ok: true });
});

const credentials = z.object({ email: z.email(), password: z.string().min(8).max(200) });

authRouter.post('/register', async (req, res) => {
  const body = credentials.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters' });
  const email = body.data.email.trim().toLowerCase();
  const taken = await db.execute({ sql: `SELECT 1 FROM identities WHERE provider = 'password' AND subject = ?`, args: [email] });
  if (taken.rows.length) return res.status(409).json({ error: 'That email is already registered. Try signing in.' });
  // Emails are not verified for password accounts (no mail service required), so never link or match on them.
  const userId = randomUUID();
  await db.batch(
    [
      { sql: 'INSERT INTO users (id, email, email_verified, name, created_at) VALUES (?, ?, 0, ?, ?)', args: [userId, email, '', Date.now()] },
      { sql: `INSERT INTO identities (provider, subject, user_id) VALUES ('password', ?, ?)`, args: [email, userId] },
      { sql: 'INSERT INTO credentials (user_id, password_hash) VALUES (?, ?)', args: [userId, await hashPassword(body.data.password)] },
    ],
    'write',
  );
  await startSession(res, userId);
  await sendVerification(userId).catch(() => undefined);
  res.status(201).json({ ok: true });
});

authRouter.post('/login', async (req, res) => {
  const body = credentials.safeParse(req.body);
  const bad = () => res.status(401).json({ error: 'Wrong email or password' });
  if (!body.success) return bad();
  const r = await db.execute({
    sql: `SELECT i.user_id, c.password_hash FROM identities i JOIN credentials c ON c.user_id = i.user_id
          WHERE i.provider = 'password' AND i.subject = ?`,
    args: [body.data.email.trim().toLowerCase()],
  });
  const found = r.rows[0] as unknown as { user_id: string; password_hash: string } | undefined;
  const ok = await checkPassword(body.data.password, found?.password_hash ?? (await dummyHash));
  if (!found || !ok) return bad();
  await startSession(res, found.user_id);
  res.json({ ok: true });
});

authRouter.post('/verify-email', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token || !(await consumeVerification(token))) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from your profile.' });
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('session', { ...cookieBase, sameSite: 'lax' });
  res.json({ ok: true });
});

authRouter.get('/:provider', async (req, res) => {
  const p = providers()[req.params.provider as ProviderId];
  if (!p) return res.status(404).send('Unknown or unconfigured provider');
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const next = safeNext(req.query.next);
  const flow = await new SignJWT({ state, nonce, next }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('10m').sign(secret);
  // Apple posts back cross-site, so this cookie must be SameSite=None.
  res.cookie('oauth', flow, {
    ...cookieBase,
    secure: env.isProd,
    sameSite: req.params.provider === 'apple' && env.isProd ? 'none' : 'lax',
    maxAge: 600_000,
  });
  const url = new URL(p.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: `${env.appUrl}/api/auth/${req.params.provider}/callback`,
    response_type: 'code',
    scope: p.scope,
    state,
    nonce,
    ...p.extraParams,
  }).toString();
  res.redirect(url.toString());
});

async function handleCallback(req: Request, res: Response) {
  const providerId = req.params.provider as ProviderId;
  const p = providers()[providerId];
  if (!p) return res.status(404).send('Unknown or unconfigured provider');
  const params: Record<string, string | undefined> = { ...(req.query as any), ...(req.body ?? {}) };
  const fail = (msg: string) => res.redirect(`${env.appUrl}/login?error=${encodeURIComponent(msg)}`);
  try {
    if (params.error) return fail(params.error);
    const flow = (await jwtVerify(req.cookies?.oauth ?? '', secret)).payload as { state: string; nonce: string; next: string };
    res.clearCookie('oauth', { ...cookieBase, sameSite: providerId === 'apple' && env.isProd ? 'none' : 'lax' });
    if (!params.code || params.state !== flow.state) return fail('Sign-in expired, please try again');

    const tokenRes = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        client_id: p.clientId,
        client_secret: await p.clientSecret(),
        redirect_uri: `${env.appUrl}/api/auth/${providerId}/callback`,
      }),
    });
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokenRes.ok || !tokens.id_token) return fail('Sign-in failed');

    if (!jwksCache.has(providerId)) jwksCache.set(providerId, createRemoteJWKSet(new URL(p.jwksUrl)));
    const { payload } = await jwtVerify(tokens.id_token, jwksCache.get(providerId)!, {
      audience: p.clientId,
      issuer: p.issuer,
    });
    if (payload.nonce !== flow.nonce) return fail('Sign-in failed');

    // Apple only sends the user's name on the very first authorisation, as a form field.
    let appleName: string | undefined;
    if (providerId === 'apple' && params.user) {
      try {
        const u = JSON.parse(params.user);
        appleName = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ');
      } catch {}
    }
    const email = (payload.email as string | undefined) ?? null;
    const trusted = p.trustsEmail(payload);
    const { userId, created } = await findOrCreateUser({
      provider: providerId,
      subject: payload.sub!,
      email,
      emailVerified: trusted,
      name: appleName || (payload.name as string | undefined),
      linkByEmail: trusted,
    });
    await startSession(res, userId);
    // Providers whose email we can't trust (Microsoft) get a confirmation link on first sign-in.
    if (created && email && !trusted) await sendVerification(userId).catch(() => undefined);
    res.redirect(`${env.appUrl}${safeNext(flow.next)}`);
  } catch (e) {
    console.error('OAuth callback failed', e);
    fail('Sign-in failed');
  }
}

authRouter.get('/:provider/callback', handleCallback);
authRouter.post('/:provider/callback', handleCallback);
