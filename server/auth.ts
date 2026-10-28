import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { SignJWT, jwtVerify, createRemoteJWKSet, importPKCS8, type JWTPayload } from 'jose';
import { z } from 'zod';
import { db } from './db.js';
import { env, publicUrlProblem } from './env.js';
import { rateLimit } from './rateLimit.js';
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
  /** Extra checks on a signature-verified ID token. Throws to refuse it. */
  checkClaims?: (claims: JWTPayload) => void;
  /** The identity key for this token when `sub` alone isn't enough (default: `sub`). */
  subjectOf?: (claims: JWTPayload) => string;
}

const PROVIDER_NAMES: Record<ProviderId, string> = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' };

const MICROSOFT_CONSUMERS_TENANT = '9188040d-6c67-4c5c-b112-d4b9e8fb6d5f';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Microsoft signs tokens for every tenant with the same keys, and with the `common` endpoint the issuer differs per
 * tenant, so a fixed `issuer` can't be checked. Instead the issuer must be the one belonging to the token's own `tid`,
 * and `tid` must be the configured tenant when one is configured.
 */
export function checkMicrosoftClaims(claims: JWTPayload, tenant: string) {
  const tid = typeof claims.tid === 'string' ? claims.tid.toLowerCase() : '';
  if (!GUID.test(tid) || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new Error('Microsoft token has the wrong issuer');
  const t = tenant.toLowerCase();
  const wanted = t === 'consumers' ? MICROSOFT_CONSUMERS_TENANT : GUID.test(t) ? t : null;
  if (wanted && tid !== wanted) throw new Error('Microsoft token is from the wrong tenant');
  if (t === 'organizations' && tid === MICROSOFT_CONSUMERS_TENANT) throw new Error('Microsoft token is from the wrong tenant');
}

/** `sub` is only unique within a tenant, so a Microsoft identity is the tenant plus the `sub`. */
export const microsoftSubject = (claims: JWTPayload) => `${String(claims.tid).toLowerCase()}:${claims.sub}`;

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
      checkClaims: (c) => checkMicrosoftClaims(c, tenant),
      subjectOf: microsoftSubject,
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
// A session lasts 30 days from the last renewal (any request more than a day after the last one re-issues it, so active
// users stay signed in), but never more than SESSION_MAX_DAYS after the actual sign-in.
const SESSION_DAYS = 30;
const SESSION_MAX_DAYS = 180;
const RENEW_AFTER_S = 86_400;

// __Host- cookies must be Secure, Path=/ and host-only, so they only work over HTTPS (production).
const cookieName = (n: string) => (env.isProd ? `__Host-${n}` : n);
const SESSION_COOKIE = cookieName('session');
const OAUTH_COOKIE = cookieName('oauth');
const MERGE_COOKIE = cookieName('merge');
const CONNECT_COOKIE = cookieName('connect');

const cookieBase = { httpOnly: true, secure: env.isProd, path: '/' } as const;

// Every token kind shares one key, so each carries a `typ` and is only accepted as that kind.
const sign = (typ: string, claims: JWTPayload, ttl: string) =>
  new SignJWT({ ...claims, typ }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(ttl).sign(secret);
const verify = async (token: string, typ: string) => {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (payload.typ !== typ) throw new Error('wrong token type');
  return payload;
};

async function issueSession(res: Response, userId: string, version: number, authAt: number) {
  const token = await sign('session', { sub: userId, ver: version, auth: authAt }, `${SESSION_DAYS}d`);
  res.cookie(SESSION_COOKIE, token, { ...cookieBase, sameSite: 'lax', maxAge: SESSION_DAYS * 86_400_000 });
}

async function startSession(res: Response, userId: string) {
  const u = await db.execute({ sql: 'SELECT session_version FROM users WHERE id = ?', args: [userId] });
  await issueSession(res, userId, Number(u.rows[0]?.session_version ?? 0), Math.floor(Date.now() / 1000));
}

/** Signs the account out everywhere (every token issued so far stops working) and keeps this browser signed in. */
export async function revokeSessions(res: Response, userId: string) {
  await db.execute({ sql: 'UPDATE users SET session_version = session_version + 1 WHERE id = ?', args: [userId] });
  await startSession(res, userId);
}

/**
 * The signed-in user's id, or null (no cookie, expired, revoked, or the account no longer exists).
 * Pass `res` to let an old-enough session renew itself.
 */
export async function readSessionUser(req: Request, res?: Response): Promise<string | null> {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const payload = await verify(token, 'session');
    const userId = payload.sub;
    if (!userId) return null;
    const user = await db.execute({ sql: 'SELECT session_version FROM users WHERE id = ?', args: [userId] });
    if (!user.rows.length || Number(user.rows[0].session_version) !== Number(payload.ver ?? 0)) return null;
    const now = Math.floor(Date.now() / 1000);
    const authAt = Number(payload.auth ?? payload.iat ?? 0);
    if (now - authAt > SESSION_MAX_DAYS * 86_400) return null;
    if (res && now - Number(payload.iat ?? 0) > RENEW_AFTER_S) await issueSession(res, userId, Number(user.rows[0].session_version), authAt);
    return userId;
  } catch {
    return null;
  }
}

/**
 * When the signed-in person actually signed in (ms since epoch), or null. Unlike the token's `iat` this is not reset
 * when the session renews itself, so a session that is merely kept alive never looks like a fresh sign-in.
 */
export async function lastSignInAt(req: Request): Promise<number | null> {
  try {
    const payload = await verify(req.cookies?.[SESSION_COOKIE] ?? '', 'session');
    const user = await db.execute({ sql: 'SELECT session_version FROM users WHERE id = ?', args: [payload.sub ?? ''] });
    if (!user.rows.length || Number(user.rows[0].session_version) !== Number(payload.ver ?? 0)) return null;
    const at = Number(payload.auth ?? payload.iat ?? 0);
    return at ? at * 1000 : null;
  } catch {
    return null;
  }
}

const REAUTH_WINDOW_MS = 10 * 60_000;

/**
 * Proof that the person at the keyboard owns the account before something security-relevant: their password, or (for
 * accounts that only sign in through a provider) a sign-in in the last few minutes. `action` completes the sentence
 * "…then <action> within a few minutes".
 */
export async function reauthenticate(
  req: Request,
  userId: string,
  action: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string; code?: string }> {
  const logins = (await db.execute({ sql: `SELECT subject FROM identities WHERE user_id = ? AND provider = 'password'`, args: [userId] })).rows;
  if (logins.length) {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    for (const l of logins) if ((await verifyPassword(String(l.subject), password)) === userId) return { ok: true };
    return { ok: false, status: 401, error: 'Wrong password' };
  }
  const issued = await lastSignInAt(req);
  if (issued && Date.now() - issued <= REAUTH_WINDOW_MS) return { ok: true };
  return { ok: false, status: 403, error: `For your security, sign out and sign in again, then ${action} within a few minutes.`, code: 'reauth_required' };
}

export const clearSessionCookie = (res: Response) => res.clearCookie(SESSION_COOKIE, { ...cookieBase, sameSite: 'lax' });

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = await readSessionUser(req, res);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  res.locals.userId = userId;
  next();
}

/** The dev login can sign in as anyone, so it only answers requests addressed to this machine. */
export const devLoginAllowed = (req: Request) => env.devLogin && /^(localhost|127\.0\.0\.1|\[::1\]|[^:]+\.localhost)$/i.test(req.hostname);

// ---------- merge tickets ----------
// While signed in as account A, proving you can sign in to account B yields a short-lived ticket naming both.
// It never replaces the session: the signed-in account stays A throughout.

const MERGE_MINUTES = 10;

export async function issueMergeTicket(res: Response, a: string, b: string) {
  const ticket = await sign('merge', { a, b }, `${MERGE_MINUTES}m`);
  res.cookie(MERGE_COOKIE, ticket, { ...cookieBase, sameSite: 'lax', maxAge: MERGE_MINUTES * 60_000 });
}

export async function readMergeTicket(req: Request): Promise<{ a: string; b: string } | null> {
  try {
    const payload = await verify(req.cookies?.[MERGE_COOKIE] ?? '', 'merge');
    return typeof payload.a === 'string' && typeof payload.b === 'string' ? { a: payload.a, b: payload.b } : null;
  } catch {
    return null;
  }
}

export const clearMergeTicket = (res: Response) => res.clearCookie(MERGE_COOKIE, { ...cookieBase, sameSite: 'lax' });

// ---------- connecting another sign-in ----------
// Adding a login to the signed-in account needs the same proof as other security changes (see `reauthenticate`), which
// yields this short-lived ticket. Starting a provider flow in connect mode spends it.

export async function issueConnectTicket(res: Response, userId: string) {
  const ticket = await sign('connect', { u: userId }, '10m');
  res.cookie(CONNECT_COOKIE, ticket, { ...cookieBase, sameSite: 'lax', maxAge: 600_000 });
}

/** The account the ticket was issued to, or null. */
async function readConnectTicket(req: Request): Promise<string | null> {
  try {
    const payload = await verify(req.cookies?.[CONNECT_COOKIE] ?? '', 'connect');
    return typeof payload.u === 'string' ? payload.u : null;
  } catch {
    return null;
  }
}

// ---------- users ----------

/** Keeps the email a provider last shared for a login, which is what tells several logins of one provider apart. */
async function rememberAccount(provider: string, subject: string, account?: string | null) {
  if (account) await db.execute({ sql: 'UPDATE identities SET account = ? WHERE provider = ? AND subject = ?', args: [account, provider, subject] });
}

async function findOrCreateUser(opts: {
  provider: string;
  subject: string;
  email?: string | null;
  emailVerified: boolean;
  name?: string | null;
  linkByEmail: boolean;
}): Promise<{ userId: string; created: boolean } | { clash: true }> {
  const existing = await db.execute({
    sql: 'SELECT user_id FROM identities WHERE provider = ? AND subject = ?',
    args: [opts.provider, opts.subject],
  });
  if (existing.rows.length) {
    await rememberAccount(opts.provider, opts.subject, opts.email);
    return { userId: existing.rows[0].user_id as string, created: false };
  }

  let userId: string | undefined;
  let created = false;
  if (opts.linkByEmail && opts.email && opts.emailVerified) {
    const byEmail = await db.execute({
      sql: 'SELECT user_id FROM user_emails WHERE email = lower(?) AND verified = 1',
      args: [opts.email],
    });
    if (byEmail.rows.length) userId = byEmail.rows[0].user_id as string;
  }
  if (!userId) {
    // This provider's email can't be trusted to link to an account, yet another account has verified it. A second
    // account on that address could never verify it (and so never be used), so refuse and point to "connect".
    if (opts.email) {
      const held = await db.execute({ sql: 'SELECT 1 FROM user_emails WHERE email = lower(?) AND verified = 1', args: [opts.email] });
      if (held.rows.length) return { clash: true };
    }
    userId = randomUUID();
    created = true;
    // No name from the provider means no display name: the user is shown by their email until they set one.
    const name = opts.name?.trim() || '';
    await db.execute({
      sql: 'INSERT INTO users (id, email, email_verified, name, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [userId, opts.email ?? null, opts.emailVerified ? 1 : 0, name, Date.now()],
    });
    if (opts.email) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO user_emails (user_id, email, verified, created_at) VALUES (?, lower(?), ?, ?)',
        args: [userId, opts.email, opts.emailVerified ? 1 : 0, Date.now()],
      });
    }
  }
  await db.execute({
    sql: 'INSERT INTO identities (provider, subject, user_id, account) VALUES (?, ?, ?, ?)',
    args: [opts.provider, opts.subject, userId, opts.email ?? null],
  });
  return { userId, created };
}

// ---------- passwords ----------

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
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

/**
 * The identity key for a verified token. Identities created before a provider used tenant-qualified keys are stored
 * under the bare `sub`; the first sign-in since then moves them to the new key.
 */
async function resolveSubject(providerId: ProviderId, p: Provider, claims: JWTPayload): Promise<string> {
  p.checkClaims?.(claims);
  const sub = claims.sub!;
  const subject = p.subjectOf?.(claims) ?? sub;
  if (subject !== sub) {
    await db.execute({
      sql: `UPDATE identities SET subject = ? WHERE provider = ? AND subject = ?
            AND NOT EXISTS (SELECT 1 FROM identities WHERE provider = ? AND subject = ?)`,
      args: [subject, providerId, sub, providerId, subject],
    });
  }
  return subject;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export const authRouter = Router();


authRouter.post('/dev', async (req, res) => {
  if (!devLoginAllowed(req)) return res.status(404).json({ error: 'Not found' });
  const body = z.object({ name: z.string().default(''), email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'name and email required' });
  const { name, email } = body.data;
  const found = await findOrCreateUser({
    provider: 'dev',
    subject: email.toLowerCase(),
    email,
    emailVerified: true,
    name,
    linkByEmail: true,
  });
  if ('clash' in found) return res.status(409).json({ error: 'That email already belongs to another account' });
  await startSession(res, found.userId);
  res.json({ ok: true });
});

const credentials = z.object({ email: z.email(), password: z.string().min(8).max(200) });

authRouter.post('/register', rateLimit('register', { perIp: 10, windowMs: 3_600_000 }), async (req, res) => {
  const body = credentials.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters' });
  const email = body.data.email.trim().toLowerCase();
  const taken = await db.execute({ sql: `SELECT 1 FROM identities WHERE provider = 'password' AND subject = ?`, args: [email] });
  // An address another account has verified could never be verified here either, so the account would be unusable.
  const held = await db.execute({ sql: 'SELECT 1 FROM user_emails WHERE email = ? AND verified = 1', args: [email] });
  if (taken.rows.length || held.rows.length) return res.status(409).json({ error: 'That email is already registered. Try signing in the way you did before.' });
  // Emails are not verified for password accounts (no mail service required), so never link or match on them.
  const userId = randomUUID();
  await db.batch(
    [
      { sql: 'INSERT INTO users (id, email, email_verified, name, created_at) VALUES (?, ?, 0, ?, ?)', args: [userId, email, '', Date.now()] },
      { sql: `INSERT INTO identities (provider, subject, user_id) VALUES ('password', ?, ?)`, args: [email, userId] },
      { sql: 'INSERT INTO user_emails (user_id, email, verified, created_at) VALUES (?, ?, 0, ?)', args: [userId, email, Date.now()] },
      { sql: 'INSERT INTO password_credentials (subject, password_hash) VALUES (?, ?)', args: [email, await hashPassword(body.data.password)] },
    ],
    'write',
  );
  await startSession(res, userId);
  await sendVerification(userId).catch(() => undefined);
  res.status(201).json({ ok: true });
});

/** The account id behind an email + password, or null. Takes the same time whether or not the email exists. */
export async function verifyPassword(email: string, password: string): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT i.user_id, c.password_hash FROM identities i JOIN password_credentials c ON c.subject = i.subject
          WHERE i.provider = 'password' AND i.subject = ?`,
    args: [email.trim().toLowerCase()],
  });
  const found = r.rows[0] as unknown as { user_id: string; password_hash: string } | undefined;
  const ok = await checkPassword(password, found?.password_hash ?? (await dummyHash));
  return found && ok ? found.user_id : null;
}

authRouter.post('/login', rateLimit('login', { perIp: 60, perBody: { field: 'email', max: 10 } }), async (req, res) => {
  const body = credentials.safeParse(req.body);
  const userId = body.success ? await verifyPassword(body.data.email, body.data.password) : null;
  if (!userId) return res.status(401).json({ error: 'Wrong email or password' });
  await startSession(res, userId);
  res.json({ ok: true });
});

authRouter.post('/verify-email', rateLimit('verify', { perIp: 30 }), async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token || !(await consumeVerification(token))) return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one from your profile.' });
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Invalidates every session of the account (other devices, a copied cookie) and keeps this browser signed in.
authRouter.post('/logout-everywhere', async (req, res) => {
  const userId = await readSessionUser(req);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });
  await revokeSessions(res, userId);
  res.json({ ok: true });
});

authRouter.get('/:provider', async (req, res) => {
  const p = providers()[req.params.provider as ProviderId];
  if (!p) return res.status(404).send('Unknown or unconfigured provider');
  const misconfigured = publicUrlProblem(env.appUrl, env.isProd);
  if (misconfigured) return res.status(500).send(misconfigured); // say so, instead of redirecting through Google to localhost
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const next = safeNext(req.query.next);
  // Merge mode: the user is signed in as account A and is proving they can sign in to another account B.
  // A's id travels in the signed flow cookie, because Apple's cross-site POST callback won't carry the session cookie.
  let merge: string | undefined;
  if (req.query.merge) {
    merge = (await readSessionUser(req)) ?? undefined;
    if (!merge) return res.redirect(`${env.appUrl}/login`);
  }
  // Connect mode: the user is signed in and adds this provider account as another way into the same account. It needs the
  // ticket from `reauthenticate`, which is spent here; the account's id travels in the flow cookie for the same reason.
  let connect: string | undefined;
  if (req.query.connect) {
    const ticket = await readConnectTicket(req);
    const me = await readSessionUser(req);
    res.clearCookie(CONNECT_COOKIE, { ...cookieBase, sameSite: 'lax' });
    if (!me || ticket !== me) return res.redirect(`${env.appUrl}/profile?error=${encodeURIComponent('That took too long. Start connecting the sign-in again.')}`);
    connect = me;
  }
  const flow = await sign('oauth', { state, nonce, next, ...(merge ? { merge } : {}), ...(connect ? { connect } : {}) }, '10m');
  // Apple posts back cross-site, so this cookie must be SameSite=None.
  res.cookie(OAUTH_COOKIE, flow, {
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
    if (params.error) {
      console.warn('OAuth provider returned an error:', params.error);
      return fail('Sign-in was cancelled or failed');
    }
    const flow = (await verify(req.cookies?.[OAUTH_COOKIE] ?? '', 'oauth')) as unknown as { state: string; nonce: string; next: string; merge?: string; connect?: string };
    res.clearCookie(OAUTH_COOKIE, { ...cookieBase, sameSite: providerId === 'apple' && env.isProd ? 'none' : 'lax' });
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
    const subject = await resolveSubject(providerId, p, payload);

    if (flow.merge) {
      // Only an existing account can be merged: never create one here, and never replace the session.
      const back = (error?: string) => res.redirect(`${env.appUrl}/merge${error ? `?error=${encodeURIComponent(error)}` : ''}`);
      const identity = await db.execute({ sql: 'SELECT user_id FROM identities WHERE provider = ? AND subject = ?', args: [providerId, subject] });
      if (!identity.rows.length) return back("No LoJuBets account uses that sign-in. Sign in with the other account's own login.");
      const other = identity.rows[0].user_id as string;
      if (other === flow.merge) return back("That's the account you're already signed in with.");
      await rememberAccount(providerId, subject, payload.email as string | undefined);
      await issueMergeTicket(res, flow.merge, other);
      return back();
    }

    if (flow.connect) {
      // The proof of ownership is the account's own session (checked when the flow started) plus a successful login at the
      // provider: the provider's email is not trusted or used. An identity that already belongs to someone is never taken over.
      const back = (error?: string) => res.redirect(`${env.appUrl}/profile?${error ? `error=${encodeURIComponent(error)}` : 'connected=1'}`);
      const owner = await db.execute({ sql: 'SELECT user_id FROM identities WHERE provider = ? AND subject = ?', args: [providerId, subject] });
      if (owner.rows.length) {
        if (owner.rows[0].user_id === flow.connect) {
          await rememberAccount(providerId, subject, payload.email as string | undefined);
          return back('That sign-in is already connected to your account.');
        }
        return back('That sign-in already belongs to another LoJuBets account. Sign in to that account and merge the two instead.');
      }
      const me = await db.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [flow.connect] });
      if (!me.rows.length) return back('Your account is gone.');
      await db.execute({
        sql: 'INSERT INTO identities (provider, subject, user_id, account) VALUES (?, ?, ?, ?)',
        args: [providerId, subject, flow.connect, (payload.email as string | undefined) ?? null],
      });
      return back();
    }

    // Apple only sends the user's name on the very first authorisation, as a form field.
    let appleName: string | undefined;
    if (providerId === 'apple' && params.user) {
      try {
        const u = JSON.parse(params.user);
        appleName = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ');
      } catch {}
    }
    const email = (payload.email as string | undefined) ?? null;
    // Every account has an email address: it is how the other bettors' requests and our notices reach people.
    if (!email) return fail("That sign-in didn't share an email address with us, and we need one to create your account.");
    const trusted = p.trustsEmail(payload);
    const found = await findOrCreateUser({
      provider: providerId,
      subject,
      email,
      emailVerified: trusted,
      name: appleName || (payload.name as string | undefined),
      linkByEmail: trusted,
    });
    if ('clash' in found) return fail(`An account with that email address already exists. Sign in the way you did before, then connect ${PROVIDER_NAMES[providerId]} from your profile page.`);
    const { userId, created } = found;
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
