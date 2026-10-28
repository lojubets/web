import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { clearSessionCookie, lastSignInAt, verifyPassword } from './auth.js';
import { db } from './db.js';
import { sendMail } from './email.js';
import { env } from './env.js';

/**
 * Account deletion (GDPR erasure). The design and its reasoning live in docs/account-deletion.md:
 *  - No ongoing bets: the account is erased at once.
 *  - Otherwise the account enters "deletion requested" and asks each counterparty to cancel. Accepting cancels the bet,
 *    refusing keeps it (and the deletion waits), and 30 days of silence cancels it by default.
 *  - Erasing removes everything personal; settled bets stay, with the deleted user replaced by a "Deleted user" placeholder.
 */

export const LAPSE_DAYS = 30;
const DAY_MS = 86_400_000;
const REAUTH_WINDOW_MS = 10 * 60_000;
const ONGOING = `('awaiting_guess', 'active', 'awaiting_confirmation')`;

type Row = Record<string, any>;
const first = (r: { rows: unknown[] }) => r.rows[0] as Row | undefined;
const uid = (res: Response): string => res.locals.userId;

/** Name and (verified) email of a user, for notices. */
async function contactOf(id: string): Promise<{ name: string; email: string | null }> {
  const u = first(await db.execute({ sql: `SELECT COALESCE(NULLIF(name, ''), email, 'A friend') AS name, CASE WHEN email_verified = 1 THEN email END AS email FROM users WHERE id = ?`, args: [id] }));
  return { name: u?.name ?? 'A friend', email: u?.email ?? null };
}

async function notify(userId: string, subject: string, body: string) {
  const { email } = await contactOf(userId);
  if (email) await sendMail(email, subject, `${body}\n\n${env.appUrl}`);
}

/** Why this user or opponent can't start a bet or send invitations right now, or null. */
export async function deletionBlock(...ids: string[]): Promise<string | null> {
  for (const id of ids) {
    const u = first(await db.execute({ sql: 'SELECT deletion_requested_at, deleted_at FROM users WHERE id = ?', args: [id] }));
    if (u?.deleted_at) return 'That account has been deleted';
    if (u?.deletion_requested_at) return 'An account that is being deleted cannot start new bets or send invitations';
  }
  return null;
}

// ---------- erasing ----------

/**
 * Erases the account if it has no ongoing bets (checked inside the same transaction). Returns false when it can't yet.
 * Everything personal goes; settled bets stay, now against a fresh "Deleted user" placeholder; cancelled bets go too.
 */
export async function tryDeleteUser(userId: string, now = Date.now()): Promise<boolean> {
  const tx = await db.transaction('write');
  let email: string | null = null;
  let name = '';
  try {
    const u = first(await tx.execute({ sql: 'SELECT email, email_verified, name, deleted_at FROM users WHERE id = ?', args: [userId] }));
    if (!u || u.deleted_at) return false;
    email = u.email_verified ? u.email : null;
    name = u.name;
    const ongoing = await tx.execute({ sql: `SELECT 1 FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status IN ${ONGOING} LIMIT 1`, args: [userId, userId] });
    if (ongoing.rows.length) return false;
    const settled = Number(first(await tx.execute({ sql: `SELECT COUNT(*) AS n FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status = 'settled'`, args: [userId, userId] }))!.n);
    const ph = settled ? randomUUID() : null;

    const S = (sql: string, args: (string | number | null)[] = []) => ({ sql, args });
    const mine = `(SELECT id FROM bets WHERE creator_id = ? OR opponent_id = ?)`;
    await tx.batch(
      [
        S(`DELETE FROM bet_cancel_requests WHERE requested_by = ? OR bet_id IN ${mine}`, [userId, userId, userId]),
        // Cancelled bets carry no result: nothing to preserve
        S(`DELETE FROM bet_reminders WHERE bet_id IN (SELECT id FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status = 'cancelled')`, [userId, userId]),
        S(`DELETE FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status = 'cancelled'`, [userId, userId]),
        ...(ph
          ? [
              S(`INSERT INTO users (id, email, email_verified, name, created_at, deleted_at) VALUES (?, NULL, 0, 'Deleted user', ?, ?)`, [ph, now, now]),
              // The deleted user's own guess goes with them; the question, the other guess and the result stay
              S(`UPDATE bets SET creator_id = ?, creator_guess = '' WHERE creator_id = ?`, [ph, userId]),
              S(`UPDATE bets SET opponent_id = ?, opponent_guess = NULL WHERE opponent_id = ?`, [ph, userId]),
              S('UPDATE bets SET winner_id = ? WHERE winner_id = ?', [ph, userId]),
              S('UPDATE bets SET outcome_proposed_by = ? WHERE outcome_proposed_by = ?', [ph, userId]),
              // Whoever shared bets with them keeps the "friend", so the history and balance read like any other
              S(
                `INSERT OR IGNORE INTO connections (user_a, user_b, created_at)
                 SELECT MIN(?, o), MAX(?, o), ? FROM (SELECT creator_id AS o FROM bets WHERE opponent_id = ? UNION SELECT opponent_id FROM bets WHERE creator_id = ?)`,
                [ph, ph, now, ph, ph],
              ),
            ]
          : []),
        S(`DELETE FROM invitations WHERE inviter_id = ? OR lower(email) IN (SELECT lower(email) FROM user_emails WHERE user_id = ? UNION SELECT lower(email) FROM users WHERE id = ? AND email IS NOT NULL)`, [userId, userId, userId]),
        S(`DELETE FROM password_credentials WHERE subject IN (SELECT subject FROM identities WHERE user_id = ? AND provider = 'password')`, [userId]),
        S('DELETE FROM credentials WHERE user_id = ?', [userId]),
        S('DELETE FROM identities WHERE user_id = ?', [userId]),
        S('DELETE FROM user_emails WHERE user_id = ?', [userId]),
        S('DELETE FROM email_verifications WHERE user_id = ?', [userId]),
        S('DELETE FROM avatars WHERE user_id = ?', [userId]),
        S('DELETE FROM connections WHERE user_a = ? OR user_b = ?', [userId, userId]),
        // Sessions are stateless cookies: once the user is gone, they stop working
        S('DELETE FROM users WHERE id = ?', [userId]),
      ],
    );
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => undefined);
    throw e;
  } finally {
    tx.close();
  }
  // The last use of the address, and nothing is logged about it
  if (email) await sendMail(email, 'Your LoJuBets account has been deleted', `Hi${name ? ` ${name}` : ''},\n\nYour account and personal data have been deleted, as you asked. Bets you settled with friends stay in their history under "Deleted user".\n\nThanks for betting with us.`);
  console.info(`account deleted: ${userId}`);
  return true;
}

// ---------- asking to be deleted ----------

/** The ongoing bets of a user, with who they are against. */
async function ongoingBets(userId: string): Promise<Row[]> {
  return (await db.execute({ sql: `SELECT * FROM bets WHERE (creator_id = ? OR opponent_id = ?) AND status IN ${ONGOING} ORDER BY created_at`, args: [userId, userId] })).rows as Row[];
}

/** Starts (or continues) a deletion. Returns true if the account is already gone. */
export async function requestDeletion(userId: string, now = Date.now()): Promise<boolean> {
  await db.execute({ sql: 'UPDATE users SET deletion_requested_at = COALESCE(deletion_requested_at, ?) WHERE id = ? AND deleted_at IS NULL', args: [now, userId] });
  const { name } = await contactOf(userId);
  for (const b of await ongoingBets(userId)) {
    const other = b.creator_id === userId ? b.opponent_id : b.creator_id;
    if (b.status === 'awaiting_guess' && b.creator_id === userId) {
      // Nobody has answered yet: the creator can always just cancel it
      await db.execute({ sql: `UPDATE bets SET status = 'cancelled' WHERE id = ?`, args: [b.id] });
      await notify(other, `Bet cancelled: ${b.question}`, `${name} is deleting their account, so the bet "${b.question}" was cancelled before you answered it.`);
      continue;
    }
    // An existing request is left alone, so asking again can't restart the 30 days
    const r = await db.execute({
      sql: 'INSERT INTO bet_cancel_requests (bet_id, requested_by, created_at) VALUES (?, ?, ?) ON CONFLICT (bet_id, requested_by) DO NOTHING',
      args: [b.id, userId, now],
    });
    if (r.rowsAffected === 1) {
      await notify(
        other,
        `${name} asks to cancel a bet`,
        `${name} is deleting their account and asks to cancel your bet "${b.question}".\n\nOpen the bet and accept or refuse. If you don't respond within ${LAPSE_DAYS} days, the bet is cancelled so the account can be deleted.`,
      );
    }
  }
  return tryDeleteUser(userId, now);
}

export async function withdrawDeletion(userId: string) {
  await db.batch(
    [
      { sql: 'UPDATE users SET deletion_requested_at = NULL WHERE id = ?', args: [userId] },
      { sql: 'DELETE FROM bet_cancel_requests WHERE requested_by = ?', args: [userId] },
    ],
    'write',
  );
}

/** After a bet is settled or cancelled: a participant waiting to be deleted may be free to go. */
export async function afterBetEnded(betId: string) {
  const b = first(await db.execute({ sql: 'SELECT creator_id, opponent_id FROM bets WHERE id = ?', args: [betId] }));
  if (!b) return;
  for (const id of [b.creator_id, b.opponent_id]) {
    const u = first(await db.execute({ sql: 'SELECT 1 AS x FROM users WHERE id = ? AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL', args: [id] }));
    if (u) await tryDeleteUser(id);
  }
}

// ---------- the cron step ----------

/** Reminders on day 7 and 23, cancelling bets whose request went unanswered for 30 days, and erasing whoever is now free. */
export async function runDeletionCron(now = Date.now()) {
  let reminders = 0;
  let lapsed = 0;
  const pending = (await db.execute(`SELECT r.*, b.question, b.creator_id, b.opponent_id FROM bet_cancel_requests r JOIN bets b ON b.id = r.bet_id WHERE r.response = 'pending'`)).rows as Row[];
  for (const r of pending) {
    const age = now - r.created_at;
    const other = r.creator_id === r.requested_by ? r.opponent_id : r.creator_id;
    const { name } = await contactOf(r.requested_by);
    if (age >= LAPSE_DAYS * DAY_MS) {
      // Claimed first, so overlapping runs can't lapse (and email) twice
      const claim = await db.execute({ sql: `UPDATE bet_cancel_requests SET response = 'lapsed', responded_at = ? WHERE bet_id = ? AND requested_by = ? AND response = 'pending'`, args: [now, r.bet_id, r.requested_by] });
      if (claim.rowsAffected !== 1) continue;
      await db.execute({ sql: `UPDATE bets SET status = 'cancelled' WHERE id = ? AND status IN ${ONGOING}`, args: [r.bet_id] });
      await notify(other, `Bet cancelled: ${r.question}`, `${name} asked you to cancel the bet "${r.question}" because they are deleting their account, and ${LAPSE_DAYS} days passed without a response. The bet has been cancelled.`);
      lapsed++;
      continue;
    }
    for (const [col, days] of [['reminded_7_at', 7], ['reminded_23_at', 23]] as const) {
      if (age < days * DAY_MS || r[col] != null) continue;
      const claim = await db.execute({ sql: `UPDATE bet_cancel_requests SET ${col} = ? WHERE bet_id = ? AND requested_by = ? AND ${col} IS NULL`, args: [now, r.bet_id, r.requested_by] });
      if (claim.rowsAffected !== 1) continue;
      const left = LAPSE_DAYS - days;
      await notify(other, `Reminder: ${name} asks to cancel a bet`, `${name} is deleting their account and asked you to cancel the bet "${r.question}". Please accept or refuse within ${left} days, or the bet is cancelled.`);
      reminders++;
    }
  }
  let deleted = 0;
  const waiting = (await db.execute('SELECT id FROM users WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL')).rows as Row[];
  for (const u of waiting) if (await tryDeleteUser(u.id, now)) deleted++;
  return { deletionReminders: reminders, deletionLapsed: lapsed, accountsDeleted: deleted };
}

// ---------- routes ----------

export const deletionRouter = Router();

const lapsesAt = (createdAt: number) => createdAt + LAPSE_DAYS * DAY_MS;

deletionRouter.get('/me/deletion', async (_req, res) => {
  const me = uid(res);
  const u = first(await db.execute({ sql: 'SELECT deletion_requested_at FROM users WHERE id = ?', args: [me] }));
  const ongoing = [];
  for (const b of await ongoingBets(me)) {
    const other = b.creator_id === me ? b.opponent_id : b.creator_id;
    const req = first(await db.execute({ sql: 'SELECT response, created_at FROM bet_cancel_requests WHERE bet_id = ? AND requested_by = ?', args: [b.id, me] }));
    ongoing.push({
      betId: b.id,
      question: b.question,
      status: b.status,
      other: { id: other, name: (await contactOf(other)).name },
      request: req ? { response: req.response, createdAt: req.created_at, lapsesAt: lapsesAt(req.created_at) } : null,
    });
  }
  res.json({ requestedAt: u?.deletion_requested_at ?? null, lapseDays: LAPSE_DAYS, ongoing });
});

/** Proof that the person at the keyboard owns the account: their password, or (for sign-in providers) a sign-in in the last few minutes. */
async function reauthenticated(req: Request, res: Response): Promise<{ ok: true } | { ok: false; status: number; error: string; code?: string }> {
  const logins = (await db.execute({ sql: `SELECT subject FROM identities WHERE user_id = ? AND provider = 'password'`, args: [uid(res)] })).rows as Row[];
  if (logins.length) {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    for (const l of logins) if ((await verifyPassword(l.subject, password)) === uid(res)) return { ok: true };
    return { ok: false, status: 401, error: 'Wrong password' };
  }
  const issued = await lastSignInAt(req);
  if (issued && Date.now() - issued <= REAUTH_WINDOW_MS) return { ok: true };
  return { ok: false, status: 403, error: 'For your security, sign out and sign in again, then delete your account within a few minutes.', code: 'reauth_required' };
}

deletionRouter.post('/me/deletion', async (req, res) => {
  if (z.literal('DELETE').safeParse(req.body?.confirm).success === false) return res.status(400).json({ error: 'Type DELETE to confirm' });
  const auth = await reauthenticated(req, res);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  const deleted = await requestDeletion(uid(res));
  if (deleted) clearSessionCookie(res);
  res.json({ deleted });
});

// "I'm stuck": a message to the maintainer, whose address stays server-side.
const lastContact = new Map<string, number>();
deletionRouter.post('/me/contact', async (req, res) => {
  const body = z.object({ message: z.string().trim().min(5).max(2000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Write a message of 5 to 2000 characters' });
  if (!env.supportEmail) return res.status(503).json({ error: "Contact isn't set up on this server" });
  const me = uid(res);
  const last = lastContact.get(me) ?? 0;
  if (Date.now() - last < 60_000) return res.status(429).json({ error: 'Please wait a minute before sending another message' });
  lastContact.set(me, Date.now());
  const { name, email } = await contactOf(me);
  const sent = await sendMail(env.supportEmail, `LoJuBets: help with account deletion (${name})`, `From: ${name} <${email ?? 'no verified email'}>, user ${me}\n\n${body.data.message}`);
  if (!sent) return res.status(502).json({ error: "We couldn't send your message. Try again later." });
  res.json({ ok: true });
});

deletionRouter.delete('/me/deletion', async (_req, res) => {
  await withdrawDeletion(uid(res));
  res.json({ ok: true });
});

// Requests other people have sent me, waiting for an answer
deletionRouter.get('/me/cancel-requests', async (_req, res) => {
  const me = uid(res);
  const rows = (
    await db.execute({
      sql: `SELECT r.bet_id, r.requested_by, r.created_at, b.question, b.status FROM bet_cancel_requests r JOIN bets b ON b.id = r.bet_id
            WHERE r.response = 'pending' AND r.requested_by != ? AND (b.creator_id = ? OR b.opponent_id = ?) AND b.status IN ${ONGOING} ORDER BY r.created_at`,
      args: [me, me, me],
    })
  ).rows as Row[];
  res.json(await Promise.all(rows.map(async (r) => ({ betId: r.bet_id, question: r.question, status: r.status, from: { id: r.requested_by, name: (await contactOf(r.requested_by)).name }, createdAt: r.created_at, lapsesAt: lapsesAt(r.created_at) }))));
});

deletionRouter.post('/bets/:id/cancel-request/:action', async (req, res) => {
  const me = uid(res);
  const action = req.params.action;
  if (action !== 'accept' && action !== 'refuse') return res.status(404).json({ error: 'Not found' });
  const r = first(
    await db.execute({
      sql: `SELECT r.requested_by FROM bet_cancel_requests r JOIN bets b ON b.id = r.bet_id
            WHERE r.bet_id = ? AND r.response = 'pending' AND r.requested_by != ? AND (b.creator_id = ? OR b.opponent_id = ?) AND b.status IN ${ONGOING}`,
      args: [req.params.id, me, me, me],
    }),
  );
  if (!r) return res.status(404).json({ error: 'There is no request to answer on this bet' });
  const now = Date.now();
  await db.execute({ sql: 'UPDATE bet_cancel_requests SET response = ?, responded_at = ? WHERE bet_id = ? AND requested_by = ?', args: [action === 'accept' ? 'accepted' : 'refused', now, req.params.id, r.requested_by] });
  if (action === 'accept') {
    await db.execute({ sql: `UPDATE bets SET status = 'cancelled' WHERE id = ? AND status IN ${ONGOING}`, args: [req.params.id] });
    await afterBetEnded(String(req.params.id));
  }
  res.json({ ok: true });
});

// A settled bet against someone who has since deleted their account can be dropped from the remaining player's history.
deletionRouter.post('/bets/:id/remove-from-history', async (req, res) => {
  const me = uid(res);
  const b = first(
    await db.execute({
      sql: `SELECT b.id, o.id AS other FROM bets b JOIN users o ON o.id = CASE WHEN b.creator_id = ? THEN b.opponent_id ELSE b.creator_id END
            WHERE b.id = ? AND (b.creator_id = ? OR b.opponent_id = ?) AND b.status = 'settled' AND o.deleted_at IS NOT NULL`,
      args: [me, req.params.id, me, me],
    }),
  );
  if (!b) return res.status(404).json({ error: 'Only bets with a deleted user can be removed from your history' });
  await db.batch(
    [
      { sql: 'DELETE FROM bet_reminders WHERE bet_id = ?', args: [b.id] },
      { sql: 'DELETE FROM bets WHERE id = ?', args: [b.id] },
      // The last bet with this placeholder takes the placeholder and its "friendship" with it
      { sql: 'DELETE FROM connections WHERE (user_a = ? OR user_b = ?) AND NOT EXISTS (SELECT 1 FROM bets WHERE creator_id = ? OR opponent_id = ?)', args: [b.other, b.other, b.other, b.other] },
      { sql: 'DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bets WHERE creator_id = ? OR opponent_id = ?)', args: [b.other, b.other, b.other] },
    ],
    'write',
  );
  res.json({ ok: true });
});
