import { randomBytes, randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppConfig, Bet, Friend, Invitation, Me, UserSummary } from '../shared/types.js';
import { authRouter, enabledProviders, requireAuth } from './auth.js';
import { balanceFor, buildParams, decide, loadParams, normalizeAnswer, tippingVerdict } from './betLogic.js';
import { proposalOf, tippingPointOf, type BetRow } from './bets.js';
import { db, ensureSchema } from './db.js';
import { sendInviteEmail } from './email.js';
import { env } from './env.js';
import { runCron } from './reminders.js';
import { sendVerification } from './verification.js';

const app = express();
app.use(express.json({ limit: '600kb' }));
app.use(express.urlencoded({ extended: false })); // Apple's form_post callback
app.use(cookieParser());
app.use('/api', async (_req, _res, next) => {
  await ensureSchema();
  next();
});

const uid = (res: Response): string => res.locals.userId;
const row = (r: { rows: any[] }) => r.rows[0] as Record<string, any> | undefined;
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

// ---------- public ----------

app.get('/api/config', (_req, res) => {
  const cfg: AppConfig = { providers: enabledProviders(), devLogin: env.devLogin };
  res.json(cfg);
});
app.use('/api/auth', authRouter);

// Called daily by Vercel Cron (which sends `Authorization: Bearer $CRON_SECRET`), or by any external pinger.
app.get('/api/cron', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret ? req.get('authorization') !== `Bearer ${secret}` : env.isProd) return res.status(secret ? 401 : 503).json({ error: 'Unauthorized' });
  res.json(await runCron());
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

// A user who hasn't chosen a display name is shown by their email address.
const SUMMARY_SQL = `u.id, COALESCE(NULLIF(u.name, ''), u.email, 'Friend') AS name, a.updated_at AS avatar_version`;
const summary = (r: Record<string, any>): UserSummary => ({
  id: r.id,
  name: r.name,
  hasAvatar: r.avatar_version != null,
  avatarVersion: Number(r.avatar_version ?? 0),
});

async function getUser(id: string): Promise<(UserSummary & { email: string | null; emailVerified: boolean; profileName: string }) | undefined> {
  const r = row(
    await db.execute({
      sql: `SELECT ${SUMMARY_SQL}, u.name AS profile_name, u.email, u.email_verified FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?`,
      args: [id],
    }),
  );
  return r && { ...summary(r), email: r.email, emailVerified: !!r.email_verified, profileName: r.profile_name ?? '' };
}

/**
 * Friends, invitations and bets unlock once the account's email is verified. (An account with no email
 * at all can never verify, so it isn't locked out of the rest of the app.)
 */
async function requireVerifiedEmail(_req: Request, res: Response, next: express.NextFunction) {
  const u = await getUser(uid(res));
  if (u?.email && !u.emailVerified) return res.status(403).json({ error: 'Verify your email address first', code: 'email_not_verified' });
  next();
}
app.use(['/api/friends', '/api/invitations', '/api/bets'], requireVerifiedEmail);

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
  const me: Me = { id: u.id, name: u.name, profileName: u.profileName, hasAvatar: u.hasAvatar, avatarVersion: u.avatarVersion, email: u.email, emailVerified: u.emailVerified };
  res.json(me);
});

app.post('/api/me/verify-email', async (_req, res) => {
  const result = await sendVerification(uid(res));
  res.status(result === 'throttled' ? 429 : 200).json({ result });
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
  if (me.email?.toLowerCase() === email) return res.status(400).json({ error: "That's your own email" });

  const existingUser = row(await db.execute({ sql: 'SELECT id FROM users WHERE lower(email) = ? AND email_verified = 1', args: [email] }));
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
  const received =
    me.email && me.emailVerified
      ? await db.execute({ sql: `${INVITE_SQL} WHERE lower(i.email) = lower(?) AND i.status = 'pending' AND i.inviter_id != ? ORDER BY i.created_at DESC`, args: [me.email, me.id] })
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
  if (checkEmail && !(me.emailVerified && me.email?.toLowerCase() === inv.email)) return res.status(403).json({ error: 'Not your invitation' });
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
  await db.execute({
    sql: `UPDATE invitations SET status = 'declined' WHERE id = ? AND status = 'pending' AND lower(email) = lower(?)`,
    args: [String(req.params.id), me.emailVerified ? (me.email ?? '') : ''],
  });
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

/** Lonkeros each friend owes me, derived from settled bets. */
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
    theirGuess: b.opponent_guess === null ? null : theirGuess,
    outcome: b.outcome,
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

const kindSchema = z.enum(['number', 'duration', 'instant']);

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
  res.json({ ok: true });
});

app.post('/api/bets/:id/propose', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'active') return res.status(409).json({ error: "The outcome can't be proposed right now" });
  const outcome = normalizeAnswer(b.kind, loadParams(b.kind, b.params), String(req.body?.outcome ?? ''), { now: Date.now(), role: 'outcome' });
  if (!outcome.ok) return res.status(400).json({ error: outcome.error });
  await db.execute({
    sql: `UPDATE bets SET outcome = ?, outcome_proposed_by = ?, proposal = 'outcome', status = 'awaiting_confirmation' WHERE id = ?`,
    args: [outcome.value, uid(res), b.id],
  });
  await respondWithBet(res, b.id);
});

app.post('/api/bets/:id/reject', async (req, res) => {
  const b = await betFor(req, res);
  if (!b) return;
  if (b.status !== 'awaiting_confirmation' || b.outcome_proposed_by === uid(res)) return res.status(409).json({ error: 'Nothing to reject' });
  await db.execute({ sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = NULL, proposal = NULL, status = 'active' WHERE id = ?`, args: [b.id] });
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
      kind === 'not_happened' ? tippingVerdict(b.kind, b.creator_guess, b.opponent_guess!) : decide(b.kind, b.creator_guess, b.opponent_guess!, b.outcome!);
    winner = verdict === 'draw' ? null : verdict === 'creator' ? b.creator_id : b.opponent_id;
  }
  // A tie is called off by agreement: it ends with no winner, so nobody's balance changes (an all-in stake included).
  await db.execute({
    sql: `UPDATE bets SET status = 'settled', winner_id = ?, settled_at = ?, settled_by = ?, proposal = NULL WHERE id = ?`,
    args: [winner, Date.now(), kind === 'tie' ? 'tie' : kind === 'not_happened' ? 'tipping_point' : 'outcome', b.id],
  });
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
