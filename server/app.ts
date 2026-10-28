import { randomBytes, randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppConfig, Bet, EmailAddress, Friend, Invitation, Me, OwnEmailAddress, OwnLogin, UserSummary } from '../shared/types.js';
import { authRouter, devLoginAllowed, enabledProviders, hashPassword, issueConnectTicket, reauthenticate, requireAuth, revokeSessions, verifyPassword } from './auth.js';
import { balanceFor, buildParams, decide, loadParams, normalizeAnswer, tippingVerdict } from './betLogic.js';
import { proposalOf, tippingPointOf, type BetRow } from './bets.js';
import { db, ensureSchema } from './db.js';
import { sendInviteEmail } from './email.js';
import { afterBetEnded, deletionBlock, deletionRouter, runDeletionCron } from './deletion.js';
import { mergeRouter } from './merge.js';
import { env } from './env.js';
import { rateLimit } from './rateLimit.js';
import { runCron } from './reminders.js';
import { passwordResetRouter } from './passwordReset.js';
import { sendVerification } from './verification.js';

const app = express();
if (env.isProd) app.set('trust proxy', 1); // behind Vercel's proxy, so req.ip is the client (for rate limiting)
app.use(express.json({ limit: '600kb' }));
// Only Apple's form_post callback sends a form body; accepting forms elsewhere would widen the CSRF surface.
app.use('/api/auth/apple/callback', express.urlencoded({ extended: false }));
app.use(cookieParser());
// CSRF defence in depth on top of SameSite=Lax: refuse state-changing requests that a browser says came from another site.
// Apple's callback is a legitimate cross-site POST (protected by the signed `state`).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/auth/apple/callback') return next();
  const origin = req.get('origin');
  const crossSite = origin ? origin === 'null' || URL.parse(origin)?.host !== req.get('host') : ['cross-site', 'same-site'].includes(req.get('sec-fetch-site') ?? '');
  if (crossSite) return res.status(403).json({ error: 'Cross-site request refused' });
  next();
});
app.use('/api', async (_req, _res, next) => {
  await ensureSchema();
  next();
});

const uid = (res: Response): string => res.locals.userId;
const row = (r: { rows: any[] }) => r.rows[0] as Record<string, any> | undefined;
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

// ---------- public ----------

app.get('/api/config', (req, res) => {
  const cfg: AppConfig = { providers: enabledProviders(), devLogin: devLoginAllowed(req), privacyContactEmail: env.privacyContactEmail ?? null };
  res.json(cfg);
});
app.use('/api/auth', passwordResetRouter);
app.use('/api/auth', authRouter);

// Called daily by Vercel Cron (which sends `Authorization: Bearer $CRON_SECRET`), or by any external pinger.
app.get('/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret ? req.get('authorization') !== `Bearer ${secret}` : env.isProd) return res.status(secret ? 401 : 503).json({ error: 'Unauthorized' });
  res.json({ ...(await runCron()), ...(await runDeletionCron()) });
});

app.get('/api/invitations/token/:token', async (req, res) => {
  const r = row(
    await db.execute({
      sql: `SELECT i.status, COALESCE(NULLIF(u.name, ''), u.email, 'Friend') AS name FROM invitations i JOIN users u ON u.id = i.inviter_id WHERE i.token = ?`,
      args: [req.params.token],
    }),
  );
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'This invitation is no longer valid' });
  res.json({ inviterName: r.name });
});

// ---------- everything below needs a session ----------

app.use('/api', requireAuth);
app.use('/api/merge', mergeRouter);

// A user who hasn't chosen a display name is shown by their email address.
const SUMMARY_SQL = `u.id, COALESCE(NULLIF(u.name, ''), u.email, 'Friend') AS name, a.updated_at AS avatar_version, u.deleted_at IS NOT NULL AS deleted`;
const summary = (r: Record<string, any>): UserSummary => ({
  id: r.id,
  name: r.name,
  hasAvatar: r.avatar_version != null,
  avatarVersion: Number(r.avatar_version ?? 0),
  deleted: !!r.deleted,
});

async function getUser(id: string): Promise<(UserSummary & { email: string | null; emailVerified: boolean; deletionRequestedAt: number | null; profileName: string; emails: OwnEmailAddress[]; logins: OwnLogin[] }) | undefined> {
  const r = row(
    await db.execute({
      sql: `SELECT ${SUMMARY_SQL}, u.name AS profile_name, u.email, u.email_verified, u.deletion_requested_at FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?`,
      args: [id],
    }),
  );
  if (!r) return undefined;
  const emails = await db.execute({ sql: 'SELECT email, verified FROM user_emails WHERE user_id = ? ORDER BY created_at, email', args: [id] });
  const primary = String(r.email ?? '').toLowerCase();
  const logins = await db.execute({ sql: 'SELECT provider, subject, account FROM identities WHERE user_id = ? ORDER BY rowid', args: [id] });
  // Addresses that a social login (Google, Microsoft, Apple) reported as its account: they belong to that sign-in
  const socialAddresses = new Map<string, string>();
  for (const l of logins.rows) {
    if (l.provider !== 'password' && l.account) socialAddresses.set(String(l.account).trim().toLowerCase(), PROVIDER_LABELS[String(l.provider)] ?? String(l.provider));
  }
  const passwordLogins = new Set(logins.rows.filter((l) => l.provider === 'password').map((l) => String(l.subject)));
  const verifiedEmails = emails.rows.filter((e) => e.verified).map((e) => String(e.email));
  const verifiedCount = verifiedEmails.length;
  // When the account's only login is a password login, removing its address moves that login to another verified address
  // (the primary one if possible) instead of leaving the account with no way in. That fails if the other address is
  // already the password login of a different account.
  const onlyPasswordLogin = logins.rows.length === 1 && passwordLogins.size === 1;
  const usedByOthers = new Set(
    onlyPasswordLogin && verifiedCount
      ? (
          await db.execute({
            sql: `SELECT subject FROM identities WHERE provider = 'password' AND user_id != ? AND subject IN (${verifiedEmails.map(() => '?').join(',')})`,
            args: [id, ...verifiedEmails],
          })
        ).rows.map((r) => String(r.subject))
      : [],
  );
  const list: OwnEmailAddress[] = emails.rows.map((e) => {
    const email = String(e.email);
    const signsInWithPassword = passwordLogins.has(email);
    const candidates = verifiedEmails.filter((v) => v !== email).sort((x, y) => Number(y === primary) - Number(x === primary));
    const movesPasswordTo = signsInWithPassword && onlyPasswordLogin ? (candidates.find((c) => !usedByOthers.has(c)) ?? null) : null;
    // Removing an address never leaves the account without a verified address, or without a way to sign in
    // (removing an address also removes the password login that uses it, unless that login moves to another address).
    // It also never pulls the address out from under a social login that was set up with it.
    const removeBlocked =
      verifiedCount - (e.verified ? 1 : 0) < 1
        ? e.verified
          ? 'This is your only verified email address.'
          : 'Verify an email address first: you need at least one verified address.'
        : socialAddresses.has(email)
          ? `This address belongs to your ${socialAddresses.get(email)} sign-in. Remove that sign-in first if you no longer want it.`
          : signsInWithPassword && onlyPasswordLogin && !movesPasswordTo
            ? candidates.length
              ? 'Your password login cannot move to your other address, because a different LoJuBets account already uses it. Merge the accounts first.'
              : 'This address is your only way to sign in.'
            : null;
    return { email, verified: !!e.verified, primary: email === primary, signsInWithPassword, movesPasswordTo, removeBlocked };
  });
  // The primary address first
  list.sort((x, y) => Number(y.primary) - Number(x.primary));
  const loginList = loginMethods(logins.rows as unknown as { provider: unknown; subject: unknown; account: unknown }[], emails.rows.filter((e) => e.verified).map((e) => String(e.email)));
  return { ...summary(r), email: r.email, emailVerified: !!r.email_verified, deletionRequestedAt: r.deletion_requested_at ?? null, profileName: r.profile_name ?? '', emails: list, logins: loginList };
}

const PROVIDER_LABELS: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple', dev: 'Development login' };

/**
 * The account's ways of signing in. A login counts as verified when it is tied to a verified address: a password login
 * uses its own email, and a provider login relies on the account having a verified address (providers don't tell us
 * which one they used). The last verified login can't be removed, so the account always keeps a way in.
 */
function loginMethods(rows: { provider: unknown; subject: unknown; account: unknown }[], verifiedEmails: string[]): OwnLogin[] {
  const verified = new Set(verifiedEmails);
  const all = rows.map((l) => {
    const provider = String(l.provider);
    const subject = String(l.subject);
    const isPassword = provider === 'password';
    return {
      provider,
      subject,
      label: isPassword ? 'Email and password' : (PROVIDER_LABELS[provider] ?? provider),
      email: isPassword ? subject : null,
      account: !isPassword && l.account ? String(l.account) : null,
      verified: isPassword ? verified.has(subject) : verified.size > 0,
    };
  });
  const verifiedCount = all.filter((l) => l.verified).length;
  return all.map(({ verified: isVerified, ...login }) => {
    // Removing this one must leave at least one verified login behind
    const blocked = verifiedCount - (isVerified ? 1 : 0) < 1;
    return {
      ...login,
      removeBlocked: !blocked
        ? null
        : isVerified
          ? 'This is your only login tied to a verified email address.'
          : 'Verify your email address first: you need at least one login tied to a verified address.',
    };
  });
}

/** The addresses this account has proven it owns. */
const verifiedAddresses = (u: { emails: EmailAddress[] }) => u.emails.filter((e) => e.verified).map((e) => e.email);

/** Friends, invitations and bets unlock once the account's email is verified: every bettor is reachable by email. */
async function requireVerifiedEmail(_req: Request, res: Response, next: express.NextFunction) {
  const u = await getUser(uid(res));
  if (!u?.emailVerified) return res.status(403).json({ error: 'Verify your email address first', code: 'email_not_verified' });
  next();
}
app.use(['/api/friends', '/api/invitations', '/api/bets'], requireVerifiedEmail);
app.use('/api', deletionRouter);

async function areConnected(a: string, b: string) {
  const [x, y] = pair(a, b);
  return (await db.execute({ sql: 'SELECT 1 FROM connections WHERE user_a = ? AND user_b = ?', args: [x, y] })).rows.length > 0;
}

async function connect(a: string, b: string) {
  const [x, y] = pair(a, b);
  await db.execute({ sql: 'INSERT OR IGNORE INTO connections (user_a, user_b, created_at) VALUES (?, ?, ?)', args: [x, y, Date.now()] });
}

// ---------- profile ----------

app.get('/api/me', async (_req, res) => {
  const u = (await getUser(uid(res)))!;
  const me: Me = { deletionRequestedAt: u.deletionRequestedAt, deleted: false, id: u.id, name: u.name, profileName: u.profileName, hasAvatar: u.hasAvatar, avatarVersion: u.avatarVersion, email: u.email, emailVerified: u.emailVerified, emails: u.emails, logins: u.logins };
  res.json(me);
});

// Everything we hold about the signed-in user that is theirs to take along (Art. 20), as a download. No password hashes.
app.get('/api/me/export', async (_req, res) => {
  const me = uid(res);
  const u = (await getUser(me))!;
  const avatar = row(await db.execute({ sql: 'SELECT mime, data FROM avatars WHERE user_id = ?', args: [me] }));
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, row(await db.execute({ sql: `SELECT COALESCE(NULLIF(name, ''), email, 'Friend') AS name FROM users WHERE id = ?`, args: [id] }))?.name ?? 'Friend');
    return names.get(id)!;
  };
  const friends = await db.execute({ sql: `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id, created_at FROM connections WHERE user_a = ? OR user_b = ?`, args: [me, me, me] });
  const bets = (await db.execute({ sql: 'SELECT * FROM bets WHERE creator_id = ? OR opponent_id = ? ORDER BY created_at', args: [me, me] })).rows as unknown as BetRow[];
  const bal = balances(me, bets.filter((b) => b.status !== 'cancelled'));
  const sent = await db.execute({ sql: 'SELECT email, status, created_at FROM invitations WHERE inviter_id = ? ORDER BY created_at', args: [me] });
  res.set('Content-Disposition', 'attachment; filename="lojubets-my-data.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    profile: { name: u.profileName, emails: u.emails.map((e) => ({ email: e.email, verified: e.verified, primary: e.primary })), avatar: avatar ? `data:${avatar.mime};base64,${avatar.data}` : null },
    friends: await Promise.all(friends.rows.map(async (f) => ({ name: await nameOf(String(f.id)), since: new Date(Number(f.created_at)).toISOString() }))),
    bets: await Promise.all(
      bets.map(async (b) => {
        const s = serializeBet(b, me, bal, bets);
        return {
          question: s.question, with: await nameOf(s.otherUserId), status: s.status, myGuess: s.myGuess, theirGuess: s.theirGuess, outcome: s.outcome,
          iWon: s.winnerId === null ? null : s.winnerId === me, stake: s.stake, created: new Date(s.createdAt).toISOString(), settled: s.settledAt ? new Date(s.settledAt).toISOString() : null,
        };
      }),
    ),
    invitationsSent: sent.rows.map((i) => ({ email: i.email, status: i.status, created: new Date(Number(i.created_at)).toISOString() })),
  });
});

app.post('/api/me/verify-email', async (_req, res) => {
  const result = await sendVerification(uid(res));
  res.status(result === 'throttled' ? 429 : 200).json({ result });
});

const MAX_EMAILS = 10;

// Add another email address to the account. It starts unverified: a link is mailed to it, and only once it is
// confirmed can it become the primary address or let the old one go.
app.post('/api/me/emails', rateLimit('add-email', { perIp: 30, perUser: 10, windowMs: 3_600_000 }), async (req, res) => {
  const body = z.object({ email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email address' });
  const me = (await getUser(uid(res)))!;
  const email = body.data.email.trim().toLowerCase();
  if (me.emails.some((e) => e.email === email)) return res.status(409).json({ error: 'That address is already on your account.' });
  if (me.emails.length >= MAX_EMAILS) return res.status(409).json({ error: `An account can have at most ${MAX_EMAILS} email addresses.` });
  const taken = row(await db.execute({ sql: 'SELECT 1 AS x FROM user_emails WHERE email = ? AND verified = 1', args: [email] }));
  if (taken) return res.status(409).json({ error: 'That address already belongs to another LoJuBets account. If both are yours, you can merge the accounts.' });
  await db.execute({ sql: 'INSERT INTO user_emails (user_id, email, verified, created_at) VALUES (?, ?, 0, ?)', args: [me.id, email, Date.now()] });
  const result = await sendVerification(me.id, email);
  res.status(201).json({ result });
});

// Mail the confirmation link for one of the account's unverified addresses again.
app.post('/api/me/emails/:email/verify', async (req, res) => {
  const result = await sendVerification(uid(res), String(req.params.email));
  if (result === 'no_email') return res.status(404).json({ error: 'That address is not on your account' });
  res.status(result === 'throttled' ? 429 : 200).json({ result });
});

// Make a verified address the primary one (the one friends see when there's no display name, and where emails go).
// It has to be verified: a primary address that isn't would lock the account out of the app.
app.post('/api/me/emails/:email/primary', async (req, res) => {
  const me = (await getUser(uid(res)))!;
  const email = String(req.params.email).trim().toLowerCase();
  const entry = me.emails.find((e) => e.email === email);
  if (!entry) return res.status(404).json({ error: 'That address is not on your account' });
  if (!entry.verified) return res.status(409).json({ error: 'Verify this address before making it your primary one.' });
  if (!entry.primary) await db.execute({ sql: 'UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', args: [email, me.id] });
  res.json({ ok: true });
});

// Remove an email address from the account. Never the last verified one (or the only way to sign in).
app.delete('/api/me/emails/:email', async (req, res) => {
  const me = (await getUser(uid(res)))!;
  const email = String(req.params.email).trim().toLowerCase();
  const entry = me.emails.find((e) => e.email === email);
  if (!entry) return res.status(404).json({ error: 'That address is not on your account' });
  if (entry.removeBlocked) return res.status(409).json({ error: entry.removeBlocked });
  await db.batch(
    [
      { sql: 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', args: [me.id, email] },
      { sql: 'DELETE FROM email_verifications WHERE user_id = ? AND email = ?', args: [me.id, email] },
      // An address that is also a password login takes the login with it, unless it is the only login: then it moves
      ...(entry.movesPasswordTo
        ? [
            { sql: `UPDATE identities SET subject = ? WHERE provider = 'password' AND user_id = ? AND subject = ?`, args: [entry.movesPasswordTo, me.id, email] },
            { sql: 'UPDATE password_credentials SET subject = ? WHERE subject = ?', args: [entry.movesPasswordTo, email] },
            { sql: 'DELETE FROM password_resets WHERE subject = ?', args: [email] },
          ]
        : [
            { sql: `DELETE FROM password_credentials WHERE subject IN (SELECT subject FROM identities WHERE provider = 'password' AND user_id = ? AND subject = ?)`, args: [me.id, email] },
            { sql: `DELETE FROM identities WHERE provider = 'password' AND user_id = ? AND subject = ?`, args: [me.id, email] },
          ]),
      // Removing the primary address promotes the oldest remaining verified one
      ...(entry.primary
        ? [
            {
              sql: `UPDATE users SET email = (SELECT email FROM user_emails WHERE user_id = ? AND verified = 1 ORDER BY created_at, email LIMIT 1), email_verified = 1 WHERE id = ?`,
              args: [me.id, me.id],
            },
          ]
        : []),
    ],
    'write',
  );
  res.json({ ok: true });
});

// Change the account's password. Each password login (email) has its own stored copy of the hash, and an account that
// came out of a merge has several, so every copy is replaced and they keep working as one password. Needs the current
// password (a stolen session alone can't take the account over), signs the account out everywhere else, and voids any
// pending reset links.
app.post('/api/me/password', rateLimit('change-password', { perIp: 60, perUser: 10 }), async (req, res) => {
  const me = (await getUser(uid(res)))!;
  const body = z.object({ currentPassword: z.string().max(200), newPassword: z.string().min(8).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Choose a new password of at least 8 characters' });
  const subjects = me.logins.filter((l) => l.provider === 'password').map((l) => l.subject);
  if (!subjects.length) return res.status(400).json({ error: 'Your account has no password login' });
  let knowsCurrent = false;
  for (const subject of subjects) if ((await verifyPassword(subject, body.data.currentPassword)) === me.id) knowsCurrent = true;
  if (!knowsCurrent) return res.status(403).json({ error: 'Your current password is wrong' });
  const hash = await hashPassword(body.data.newPassword);
  await db.batch(
    subjects.flatMap((subject) => [
      { sql: 'UPDATE password_credentials SET password_hash = ? WHERE subject = ?', args: [hash, subject] },
      { sql: 'DELETE FROM password_resets WHERE subject = ?', args: [subject] },
    ]),
    'write',
  );
  await revokeSessions(res, me.id);
  res.json({ ok: true });
});

// First step of connecting another provider account: the same proof as for deleting the account (password, or a recent
// sign-in). The browser then goes to /api/auth/<provider>?connect=1, which spends the ticket this issues.
app.post('/api/me/connect', rateLimit('connect', { perIp: 60, perUser: 10 }), async (req, res) => {
  const auth = await reauthenticate(req, uid(res), 'connect the sign-in');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  await issueConnectTicket(res, uid(res));
  res.json({ ok: true });
});

// Remove a way of signing in. The account keeps its email addresses; only the login goes (and a password with it).
app.delete('/api/me/logins/:provider/:subject', async (req, res) => {
  const me = (await getUser(uid(res)))!;
  const { provider, subject } = req.params;
  const entry = me.logins.find((l) => l.provider === provider && l.subject === subject);
  if (!entry) return res.status(404).json({ error: 'That login is not on your account' });
  if (entry.removeBlocked) return res.status(409).json({ error: entry.removeBlocked });
  await db.batch(
    [
      ...(provider === 'password'
        ? [
            { sql: 'DELETE FROM password_credentials WHERE subject = ?', args: [subject] },
            { sql: 'DELETE FROM password_resets WHERE subject = ?', args: [subject] },
          ]
        : []),
      { sql: 'DELETE FROM identities WHERE provider = ? AND subject = ? AND user_id = ?', args: [provider, subject, me.id] },
    ],
    'write',
  );
  res.json({ ok: true });
});

app.put('/api/me', async (req, res) => {
  // An empty name is allowed: it clears the display name, and the email address is shown instead.
  const body = z.object({ name: z.string().trim().max(60) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Display name can be at most 60 characters' });
  await db.execute({ sql: 'UPDATE users SET name = ? WHERE id = ?', args: [body.data.name, uid(res)] });
  res.json({ ok: true });
});

app.put('/api/me/avatar', async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ''));
  if (!m || m[2].length > 400_000) return res.status(400).json({ error: 'Please upload a smaller JPEG, PNG or WebP image' });
  await db.execute({
    sql: `INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
    args: [uid(res), m[1], m[2], Date.now()],
  });
  res.json({ ok: true });
});

app.delete('/api/me/avatar', async (_req, res) => {
  await db.execute({ sql: 'DELETE FROM avatars WHERE user_id = ?', args: [uid(res)] });
  res.json({ ok: true });
});

// Avatars are visible to yourself and to people you're connected with.
app.get('/api/users/:id/avatar', async (req, res) => {
  const id = String(req.params.id);
  if (id !== uid(res) && !(await areConnected(uid(res), id))) return res.status(404).end();
  const a = row(await db.execute({ sql: 'SELECT mime, data FROM avatars WHERE user_id = ?', args: [id] }));
  if (!a) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable'); // URL carries ?v=<version>
  res.type(a.mime).send(Buffer.from(a.data, 'base64'));
});

// ---------- invitations ----------

const INVITE_SQL = `SELECT i.id, i.email, i.token, i.status, i.created_at, ${SUMMARY_SQL}
  FROM invitations i JOIN users u ON u.id = i.inviter_id LEFT JOIN avatars a ON a.user_id = u.id`;
const toInvitation = (r: Record<string, any>): Invitation => ({
  id: r.id,
  email: r.email,
  token: r.token,
  status: r.status,
  inviter: summary(r),
  createdAt: r.created_at,
});

app.post('/api/invitations', async (req, res) => {
  const body = z.object({ email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter a valid email address' });
  const email = body.data.email.trim().toLowerCase();
  const me = (await getUser(uid(res)))!;
  // Invitations go out under the inviter's identity, so it must be an address they've proven they own.
  if (!me.emailVerified) return res.status(403).json({ error: 'Verify your email address before inviting friends' });
  if (me.emails.some((e) => e.email === email)) return res.status(400).json({ error: "That's your own email" });
  const blocked = await deletionBlock(me.id);
  if (blocked) return res.status(409).json({ error: blocked });

  const existingUser = row(await db.execute({ sql: 'SELECT user_id AS id FROM user_emails WHERE email = ? AND verified = 1', args: [email] }));
  if (existingUser && (await areConnected(me.id, existingUser.id))) {
    return res.status(409).json({ error: "You're already connected" });
  }
  let inv = row(await db.execute({ sql: `SELECT id, token FROM invitations WHERE inviter_id = ? AND email = ? AND status = 'pending'`, args: [me.id, email] }));
  if (!inv) {
    inv = { id: randomUUID(), token: randomBytes(18).toString('base64url') };
    await db.execute({
      sql: `INSERT INTO invitations (id, token, inviter_id, email, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      args: [inv.id, inv.token, me.id, email, Date.now()],
    });
  }
  const link = `${env.appUrl}/invite/${inv.token}`;
  const emailSent = await sendInviteEmail(email, me.name, link);
  res.status(201).json({ link, emailSent });
});

app.get('/api/invitations', async (_req, res) => {
  const me = (await getUser(uid(res)))!;
  const sent = await db.execute({ sql: `${INVITE_SQL} WHERE i.inviter_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`, args: [me.id] });
  // Invitations to any address this account has verified (a merged account has several)
  const mine = verifiedAddresses(me);
  const received = mine.length
    ? await db.execute({
        sql: `${INVITE_SQL} WHERE lower(i.email) IN (${mine.map(() => '?').join(',')}) AND i.status = 'pending' AND i.inviter_id != ? ORDER BY i.created_at DESC`,
        args: [...mine, me.id],
      })
    : { rows: [] };
  res.json({
    sent: sent.rows.map(toInvitation),
    // The token stays private to the inviter.
    received: received.rows.map((r) => ({ ...toInvitation(r), token: '' })),
  });
});

async function acceptInvitation(res: Response, where: string, arg: string, checkEmail: boolean) {
  const me = (await getUser(uid(res)))!;
  const inv = row(await db.execute({ sql: `SELECT * FROM invitations WHERE ${where} = ? AND status = 'pending'`, args: [arg] }));
  if (!inv) return res.status(404).json({ error: 'Invitation not found' });
  if (checkEmail && !verifiedAddresses(me).includes(String(inv.email).toLowerCase())) return res.status(403).json({ error: 'Not your invitation' });
  if (inv.inviter_id === me.id) return res.status(400).json({ error: "You can't accept your own invitation" });
  await connect(me.id, inv.inviter_id);
  await db.execute({ sql: `UPDATE invitations SET status = 'accepted' WHERE id = ?`, args: [inv.id] });
  res.json({ friendId: inv.inviter_id });
}

// The token itself proves the recipient got the link (works for any email on the account).
app.post('/api/invitations/token/:token/accept', (req, res) => acceptInvitation(res, 'token', String(req.params.token), false));
app.post('/api/invitations/:id/accept', (req, res) => acceptInvitation(res, 'id', String(req.params.id), true));

app.post('/api/invitations/:id/decline', async (req, res) => {
  const me = (await getUser(uid(res)))!;
  const mine = verifiedAddresses(me);
  if (mine.length) {
    await db.execute({
      sql: `UPDATE invitations SET status = 'declined' WHERE id = ? AND status = 'pending' AND lower(email) IN (${mine.map(() => '?').join(',')})`,
      args: [String(req.params.id), ...mine],
    });
  }
  res.json({ ok: true });
});

app.delete('/api/invitations/:id', async (req, res) => {
  await db.execute({ sql: `UPDATE invitations SET status = 'revoked' WHERE id = ? AND inviter_id = ? AND status = 'pending'`, args: [String(req.params.id), uid(res)] });
  res.json({ ok: true });
});

// ---------- bets ----------

async function loadBets(me: string): Promise<BetRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status != 'cancelled' ORDER BY created_at DESC`,
    args: [me, me],
  });
  return r.rows as unknown as BetRow[];
}

const otherOf = (b: BetRow, me: string) => (b.creator_id === me ? b.opponent_id : b.creator_id);

/** GTs each friend owes me, derived from settled bets. */
function balances(me: string, bets: BetRow[]): Map<string, number> {
  const by = new Map<string, { winnerId: string | null; stake: number }[]>();
  for (const b of bets) {
    if (b.status !== 'settled') continue;
    const o = otherOf(b, me);
    by.set(o, [...(by.get(o) ?? []), { winnerId: b.winner_id, stake: b.stake }]);
  }
  return new Map([...by].map(([o, list]) => [o, balanceFor(me, list)]));
}

function serializeBet(b: BetRow, me: string, bal: Map<string, number>, allBets: BetRow[]): Bet {
  const iAmCreator = b.creator_id === me;
  const other = otherOf(b, me);
  const myGuess = iAmCreator ? b.creator_guess : b.opponent_guess;
  const theirGuess = iAmCreator ? b.opponent_guess : b.creator_guess;
  const tp = b.status === 'active' ? tippingPointOf(b) : null;
  const now = Date.now();
  const tippingPassed = tp !== null && now >= tp;
  const needsMyAction =
    (b.status === 'awaiting_guess' && !iAmCreator) ||
    (b.status === 'awaiting_confirmation' && b.outcome_proposed_by !== me) ||
    tippingPassed; // both players are asked whether the event has happened
  const debt = -(bal.get(other) ?? 0);
  const anotherAllInOpen = allBets.some(
    (x) => x.id !== b.id && x.all_in && otherOf(x, me) === other && (x.status === 'active' || x.status === 'awaiting_confirmation'),
  );
  return {
    id: b.id,
    question: b.question,
    kind: b.kind,
    params: loadParams(b.kind, b.params),
    status: b.status,
    otherUserId: other,
    iAmCreator,
    myGuess,
    // Guesses stay secret until both players have locked theirs in. This is the only place guesses leave the
    // server, and nothing derived from both of them (tipping point, verdicts) is exposed before that either.
    // (a deleted user's own guess is gone: stored as '')
    theirGuess: b.opponent_guess === null || theirGuess === '' ? null : theirGuess,
    outcome: b.outcome,
    proposedVerdict: b.status !== 'awaiting_confirmation' || b.kind !== 'text' || proposalOf(b) !== 'outcome' || !b.proposed_verdict
      ? null
      : b.proposed_verdict === 'draw' ? 'draw' : (b.proposed_verdict === 'creator') === iAmCreator ? 'me' : 'them',
    outcomeProposedByMe: b.outcome_proposed_by ? b.outcome_proposed_by === me : null,
    winnerId: b.winner_id,
    allIn: !!b.all_in,
    stake: b.stake,
    settledBy: b.status === 'settled' ? (b.settled_by === 'tipping_point' || b.settled_by === 'tie' ? b.settled_by : 'outcome') : null,
    tippingPoint: tp,
    tippingSoon: tp !== null && tp > now && tp - now <= 48 * 3_600_000,
    tippingPassed,
    proposalKind: proposalOf(b),
    needsMyAction,
    canAllIn: b.status === 'active' && !b.all_in && debt > 0 && !anotherAllInOpen,
    allInStake: Math.max(debt, 0),
    createdAt: b.created_at,
    settledAt: b.settled_at,
  };
}

app.get('/api/friends', async (_req, res) => {
  const me = uid(res);
  const conns = await db.execute({
    sql: `SELECT ${SUMMARY_SQL} FROM connections c
          JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
          LEFT JOIN avatars a ON a.user_id = u.id
          WHERE c.user_a = ? OR c.user_b = ? ORDER BY COALESCE(NULLIF(u.name, ''), u.email, 'Friend') COLLATE NOCASE`,
    args: [me, me, me],
  });
  const bets = await loadBets(me);
  const bal = balances(me, bets);
  const friends: Friend[] = conns.rows.map((r) => {
    const s = summary(r);
    const theirs = bets.filter((b) => otherOf(b, me) === s.id);
    const open = theirs.filter((b) => b.status !== 'settled');
    return {
      ...s,
      balance: bal.get(s.id) ?? 0,
      openBets: open.length,
      needsMyAction: theirs.filter((b) => serializeBet(b, me, bal, bets).needsMyAction).length,
    };
  });
  res.json(friends);
});

app.get('/api/bets', async (req, res) => {
  const me = uid(res);
  const bets = await loadBets(me);
  const bal = balances(me, bets);
  const w = typeof req.query.with === 'string' ? req.query.with : null;
  res.json(bets.filter((b) => !w || otherOf(b, me) === w).map((b) => serializeBet(b, me, bal, bets)));
});

async function betFor(req: Request, res: Response): Promise<BetRow | undefined> {
  const b = row(await db.execute({ sql: 'SELECT * FROM bets WHERE id = ? AND (creator_id = ? OR opponent_id = ?)', args: [String(req.params.id), uid(res), uid(res)] })) as BetRow | undefined;
  if (!b) res.status(404).json({ error: 'Bet not found' });
  return b;
}

async function respondWithBet(res: Response, id: string, status = 200) {
  const me = uid(res);
  const bets = await loadBets(me);
  const b = bets.find((x) => x.id === id);
  res.status(status).json(b ? serializeBet(b, me, balances(me, bets), bets) : null);
}

app.get('/api/bets/:id', async (req, res) => {
  const b = await betFor(req, res);
  if (b) await respondWithBet(res, b.id);
});

const kindSchema = z.enum(['number', 'duration', 'instant', 'text', 'yesno', 'choice']);

app.post('/api/bets', async (req, res) => {
  const body = z
    .object({ opponentId: z.string(), question: z.string().trim().min(3).max(200), kind: kindSchema, params: z.unknown().optional(), guess: z.string() })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Give the bet a question (3–200 characters) and your guess' });
  const { opponentId, question, kind } = body.data;
  const params = buildParams(kind, body.data.params);
  if (!params.ok) return res.status(400).json({ error: params.error });
  const guess = normalizeAnswer(kind, params.value, body.data.guess, { now: Date.now(), role: 'guess' });
  if (!guess.ok) return res.status(400).json({ error: guess.error });
  if (!(await areConnected(uid(res), opponentId))) return res.status(403).json({ error: 'You can only bet with connected friends' });
  const blocked = await deletionBlock(uid(res), opponentId);
  if (blocked) return res.status(409).json({ error: blocked });
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO bets (id, creator_id, opponent_id, question, kind, params, status, creator_guess, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'awaiting_guess', ?, ?)`,
    args: [id, uid(res), opponentId, question, kind, JSON.stringify(params.value), guess.value, Date.now()],
  });
  await respondWithBet(res, id, 201);
});

app.post('/api/bets/:id/guess', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.opponent_id !== uid(res) || b.status !== 'awaiting_guess') return res.status(409).json({ error: "You can't guess on this bet right now" });
  const guess = normalizeAnswer(b.kind, loadParams(b.kind, b.params), String(req.body?.guess ?? ''), { now: Date.now(), role: 'guess' });
  if (!guess.ok) return res.status(400).json({ error: guess.error });
  await db.execute({ sql: `UPDATE bets SET opponent_guess = ?, status = 'active' WHERE id = ?`, args: [guess.value, b.id] });
  await respondWithBet(res, b.id);
});

app.post('/api/bets/:id/cancel', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'awaiting_guess') return res.status(409).json({ error: 'Only bets nobody has answered yet can be cancelled' });
  await db.execute({ sql: `UPDATE bets SET status = 'cancelled' WHERE id = ?`, args: [b.id] });
  await afterBetEnded(b.id);
  res.json({ ok: true });
});

app.post('/api/bets/:id/propose', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  // Besides an in-play bet, the player who is being asked to confirm may answer with a proposal of their own.
  // That replaces the pending one and hands the decision back, with no limit on how often this can happen.
  const countering = b.status === 'awaiting_confirmation' && proposalOf(b) === 'outcome' && b.outcome_proposed_by !== uid(res);
  if (b.status !== 'active' && !countering) return res.status(409).json({ error: "The outcome can't be proposed right now" });
  const outcome = normalizeAnswer(b.kind, loadParams(b.kind, b.params), String(req.body?.outcome ?? ''), { now: Date.now(), role: 'outcome' });
  if (!outcome.ok) return res.status(400).json({ error: outcome.error });
  // Free text can't be compared by a computer, so the proposer also says who was right.
  let verdict: 'creator' | 'opponent' | 'draw' | null = null;
  if (b.kind === 'text') {
    const winner = req.body?.winner;
    if (winner !== 'me' && winner !== 'them' && winner !== 'draw') return res.status(400).json({ error: 'Say who was right' });
    const iAmCreator = b.creator_id === uid(res);
    verdict = winner === 'draw' ? 'draw' : (winner === 'me') === iAmCreator ? 'creator' : 'opponent';
  }
  await db.execute({
    sql: `UPDATE bets SET outcome = ?, outcome_proposed_by = ?, proposed_verdict = ?, proposal = 'outcome', status = 'awaiting_confirmation' WHERE id = ?`,
    args: [outcome.value, uid(res), verdict, b.id],
  });
  await respondWithBet(res, b.id);
});

app.post('/api/bets/:id/reject', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'awaiting_confirmation' || b.outcome_proposed_by === uid(res)) return res.status(409).json({ error: 'Nothing to reject' });
  await db.execute({ sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = NULL, proposed_verdict = NULL, proposal = NULL, status = 'active' WHERE id = ?`, args: [b.id] });
  await respondWithBet(res, b.id);
});

// The player who made a proposal (a result, a tie, "it hasn't happened") can take it back; the bet goes back in play.
app.post('/api/bets/:id/withdraw', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'awaiting_confirmation' || b.outcome_proposed_by !== uid(res)) return res.status(409).json({ error: 'You have no proposal to withdraw' });
  await db.execute({ sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = NULL, proposed_verdict = NULL, proposal = NULL, status = 'active' WHERE id = ?`, args: [b.id] });
  await respondWithBet(res, b.id);
});

app.post('/api/bets/:id/confirm', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'awaiting_confirmation' || b.outcome_proposed_by === uid(res)) return res.status(409).json({ error: 'Nothing to confirm' });
  const kind = proposalOf(b);
  let winner: string | null = null;
  if (kind !== 'tie') {
    // "Not happened" = the event hadn't happened by the tipping point, so the later guess wins.
    const verdict =
      kind === 'not_happened'
        ? tippingVerdict(b.kind, b.creator_guess, b.opponent_guess!)
        : b.kind === 'text'
          ? (b.proposed_verdict ?? 'draw')
          : decide(b.kind, b.creator_guess, b.opponent_guess!, b.outcome!);
    winner = verdict === 'draw' ? null : verdict === 'creator' ? b.creator_id : b.opponent_id;
  }
  // A tie is called off by agreement: it ends with no winner, so nobody's balance changes (an all-in stake included).
  await db.execute({
    sql: `UPDATE bets SET status = 'settled', winner_id = ?, settled_at = ?, settled_by = ?, proposal = NULL WHERE id = ?`,
    args: [winner, Date.now(), kind === 'tie' ? 'tie' : kind === 'not_happened' ? 'tipping_point' : 'outcome', b.id],
  });
  await afterBetEnded(b.id);
  await respondWithBet(res, b.id);
});

// Both players have locked in but can't settle it: either may propose calling the bet off, if the other agrees.
app.post('/api/bets/:id/propose-tie', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'active') return res.status(409).json({ error: "A tie can only be proposed once you've both locked in your guesses" });
  await db.execute({
    sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = ?, proposal = 'tie', status = 'awaiting_confirmation' WHERE id = ?`,
    args: [uid(res), b.id],
  });
  await respondWithBet(res, b.id);
});

// "The tipping point has passed and the event still hasn't happened": the other player must agree.
app.post('/api/bets/:id/not-happened', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  const tp = b.status === 'active' ? tippingPointOf(b) : null;
  if (tp === null || Date.now() < tp) return res.status(409).json({ error: "The tipping point hasn't passed yet" });
  await db.execute({
    sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = ?, proposal = 'not_happened', status = 'awaiting_confirmation' WHERE id = ?`,
    args: [uid(res), b.id],
  });
  await respondWithBet(res, b.id);
});

// Double or nothing: the one in the red puts their whole debt on this bet.
app.post('/api/bets/:id/all-in', async (req, res) => {
  const me = uid(res);
  const b = await betFor(req, res);
  if (!b) return;
  const bets = await loadBets(me);
  const s = serializeBet(b, me, balances(me, bets), bets);
  if (!s.canAllIn) return res.status(409).json({ error: "You can't go all-in on this bet" });
  await db.execute({ sql: 'UPDATE bets SET all_in = 1, stake = ? WHERE id = ?', args: [s.allInStake, b.id] });
  await respondWithBet(res, b.id);
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

export default app;
