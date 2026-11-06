import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { clearSessionCookie, reauthenticate } from './auth.js';
import { cancelBet, settleInvitations } from './bets.js';
import { db } from './db.js';
import { sendMail } from './email.js';
import { env } from './env.js';
import { hit, rateLimit } from './rateLimit.js';

/**
 * Account deletion (GDPR erasure). The design and its reasoning live in docs/account-deletion.md:
 *  - No ongoing bets: the account is erased at once.
 *  - Otherwise the account enters "deletion requested" and asks each counterparty to cancel. Accepting cancels the bet,
 *    refusing keeps it (and the deletion waits), and 30 days of silence cancels it by default.
 *  - Erasing removes everything personal; settled bets stay, with the deleted user replaced by a "Deleted user" placeholder.
 */

export const LAPSE_DAYS = 30;
const DAY_MS = 86_400_000;
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
    const ongoing = await tx.execute({ sql: `SELECT 1 FROM bets b JOIN bet_participants p ON p.bet_id = b.id WHERE p.user_id = ? AND p.status IN ('invited', 'joined') AND b.status IN ${ONGOING} LIMIT 1`, args: [userId] });
    if (ongoing.rows.length) return false;
    const settled = Number(first(await tx.execute({ sql: `SELECT COUNT(*) AS n FROM bets b JOIN bet_participants p ON p.bet_id = b.id WHERE p.user_id = ? AND p.status = 'joined' AND b.status = 'settled'`, args: [userId] }))!.n);
    const ph = settled ? randomUUID() : null;

    const S = (sql: string, args: (string | number | null)[] = []) => ({ sql, args });
    const mine = `(SELECT bet_id FROM bet_participants WHERE user_id = ?)`;
    const cancelled = `(SELECT b.id FROM bets b JOIN bet_participants p ON p.bet_id = b.id WHERE p.user_id = ? AND b.status = 'cancelled')`;
    await tx.batch(
      [
        S(`DELETE FROM bet_cancel_requests WHERE requested_by = ? OR bet_id IN ${mine}`, [userId, userId]),
        // Cancelled bets carry no result: nothing to preserve
        S(`DELETE FROM bet_reminders WHERE bet_id IN ${cancelled}`, [userId]),
        S(`DELETE FROM bet_settlements WHERE bet_id IN ${cancelled}`, [userId]),
        S(`DELETE FROM bets WHERE id IN ${cancelled}`, [userId]),
        S(`DELETE FROM bet_participants WHERE NOT EXISTS (SELECT 1 FROM bets WHERE bets.id = bet_participants.bet_id)`),
        // Invitations they turned down, or were left out of, are nobody's business any more
        S(`DELETE FROM bet_participants WHERE user_id = ? AND status IN ('declined', 'revoked')`, [userId]),
        ...(ph
          ? [
              S(`INSERT INTO users (id, email, email_verified, name, created_at, deleted_at) VALUES (?, NULL, 0, 'Deleted user', ?, ?)`, [ph, now, now]),
              // The deleted user's own guess goes with them; the question, the other guesses and the result stay
              S(`UPDATE bet_participants SET user_id = ?, guess = NULL WHERE user_id = ?`, [ph, userId]),
              S('UPDATE bet_settlements SET payer_id = ? WHERE payer_id = ?', [ph, userId]),
              S('UPDATE bet_settlements SET payee_id = ? WHERE payee_id = ?', [ph, userId]),
              S('UPDATE bets SET creator_id = ? WHERE creator_id = ?', [ph, userId]),
              S('UPDATE bets SET outcome_proposed_by = ? WHERE outcome_proposed_by = ?', [ph, userId]),
              // Whoever shared bets with them keeps the "friend", so the history and balance read like any other
              S(
                `INSERT OR IGNORE INTO connections (user_a, user_b, created_at)
                 SELECT MIN(?, o), MAX(?, o), ? FROM (SELECT DISTINCT y.user_id AS o FROM bet_participants x JOIN bet_participants y ON y.bet_id = x.bet_id
                                                      WHERE x.user_id = ? AND y.user_id != ? AND y.status = 'joined')`,
                [ph, ph, now, ph, ph],
              ),
            ]
          : []),
        S(`DELETE FROM invitations WHERE inviter_id = ? OR lower(email) IN (SELECT lower(email) FROM user_emails WHERE user_id = ? UNION SELECT lower(email) FROM users WHERE id = ? AND email IS NOT NULL)`, [userId, userId, userId]),
        S(`DELETE FROM password_resets WHERE subject IN (SELECT subject FROM identities WHERE user_id = ? AND provider = 'password')`, [userId]),
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

/** The ongoing bets a user is in or invited to. */
async function ongoingBets(userId: string): Promise<Row[]> {
  return (
    await db.execute({
      sql: `SELECT b.*, p.status AS my_status FROM bets b JOIN bet_participants p ON p.bet_id = b.id
            WHERE p.user_id = ? AND p.status IN ('invited', 'joined') AND b.status IN ${ONGOING} ORDER BY b.created_at`,
      args: [userId],
    })
  ).rows as Row[];
}

/** The other players of a bet (those in it, or asked into it). */
async function othersIn(betId: string, userId: string): Promise<string[]> {
  const r = await db.execute({ sql: `SELECT user_id FROM bet_participants WHERE bet_id = ? AND user_id != ? AND status IN ('invited', 'joined')`, args: [betId, userId] });
  return r.rows.map((x) => String(x.user_id));
}

/** Starts (or continues) a deletion. Returns true if the account is already gone. */
export async function requestDeletion(userId: string, now = Date.now()): Promise<boolean> {
  await db.execute({ sql: 'UPDATE users SET deletion_requested_at = COALESCE(deletion_requested_at, ?) WHERE id = ? AND deleted_at IS NULL', args: [now, userId] });
  const { name } = await contactOf(userId);
  for (const b of await ongoingBets(userId)) {
    const others = await othersIn(b.id, userId);
    if (b.status === 'awaiting_guess') {
      if (b.creator_id === userId) {
        // The bet hasn't started: the creator can always just cancel it
        await cancelBet(b.id);
        for (const o of others) await notify(o, `Bet cancelled: ${b.question}`, `${name} is deleting their account, so the bet "${b.question}" was cancelled before it started.`);
      } else {
        // ...and anyone else can simply step out of it (which may leave too few players, and cancel it)
        await db.execute({ sql: `UPDATE bet_participants SET status = 'declined', guess = NULL, responded_at = ? WHERE bet_id = ? AND user_id = ?`, args: [now, b.id, userId] });
        await settleInvitations(b.id, now);
      }
      continue;
    }
    // An existing request is left alone, so asking again can't restart the 30 days
    const r = await db.execute({
      sql: 'INSERT INTO bet_cancel_requests (bet_id, requested_by, created_at) VALUES (?, ?, ?) ON CONFLICT (bet_id, requested_by) DO NOTHING',
      args: [b.id, userId, now],
    });
    if (r.rowsAffected === 1) {
      for (const o of others) {
        await notify(
          o,
          `${name} asks to cancel a bet`,
          `${name} is deleting their account and asks to cancel your bet "${b.question}".\n\nOpen the bet and accept or refuse. If nobody responds within ${LAPSE_DAYS} days, the bet is cancelled so the account can be deleted.`,
        );
      }
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
  const waiting = await db.execute({
    sql: 'SELECT u.id FROM bet_participants p JOIN users u ON u.id = p.user_id WHERE p.bet_id = ? AND u.deletion_requested_at IS NOT NULL AND u.deleted_at IS NULL',
    args: [betId],
  });
  for (const u of waiting.rows) await tryDeleteUser(String(u.id));
}

// ---------- the cron step ----------

/** Reminders on day 7 and 23, cancelling bets whose request went unanswered for 30 days, and erasing whoever is now free. */
export async function runDeletionCron(now = Date.now()) {
  let reminders = 0;
  let lapsed = 0;
  const pending = (await db.execute(`SELECT r.*, b.question FROM bet_cancel_requests r JOIN bets b ON b.id = r.bet_id WHERE r.response = 'pending'`)).rows as Row[];
  for (const r of pending) {
    const age = now - r.created_at;
    const others = await othersIn(r.bet_id, r.requested_by);
    const { name } = await contactOf(r.requested_by);
    if (age >= LAPSE_DAYS * DAY_MS) {
      // Claimed first, so overlapping runs can't lapse (and email) twice
      const claim = await db.execute({ sql: `UPDATE bet_cancel_requests SET response = 'lapsed', responded_at = ? WHERE bet_id = ? AND requested_by = ? AND response = 'pending'`, args: [now, r.bet_id, r.requested_by] });
      if (claim.rowsAffected !== 1) continue;
      await cancelBet(r.bet_id);
      for (const o of others) await notify(o, `Bet cancelled: ${r.question}`, `${name} asked you to cancel the bet "${r.question}" because they are deleting their account, and ${LAPSE_DAYS} days passed without a response. The bet has been cancelled.`);
      lapsed++;
      continue;
    }
    for (const [col, days] of [['reminded_7_at', 7], ['reminded_23_at', 23]] as const) {
      if (age < days * DAY_MS || r[col] != null) continue;
      const claim = await db.execute({ sql: `UPDATE bet_cancel_requests SET ${col} = ? WHERE bet_id = ? AND requested_by = ? AND ${col} IS NULL`, args: [now, r.bet_id, r.requested_by] });
      if (claim.rowsAffected !== 1) continue;
      const left = LAPSE_DAYS - days;
      for (const o of others) await notify(o, `Reminder: ${name} asks to cancel a bet`, `${name} is deleting their account and asked you to cancel the bet "${r.question}". Please accept or refuse within ${left} days, or the bet is cancelled.`);
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
    const others = await othersIn(b.id, me);
    const req = first(await db.execute({ sql: 'SELECT response, created_at FROM bet_cancel_requests WHERE bet_id = ? AND requested_by = ?', args: [b.id, me] }));
    ongoing.push({
      betId: b.id,
      question: b.question,
      status: b.status,
      other: { id: others[0] ?? '', name: (await Promise.all(others.map(async (o) => (await contactOf(o)).name))).join(', ') },
      request: req ? { response: req.response, createdAt: req.created_at, lapsesAt: lapsesAt(req.created_at) } : null,
    });
  }
  res.json({ requestedAt: u?.deletion_requested_at ?? null, lapseDays: LAPSE_DAYS, ongoing });
});

// The password check below is a password oracle for whoever holds the session, so it is throttled like the login.
deletionRouter.post('/me/deletion', rateLimit('delete', { perIp: 60, perUser: 10 }), async (req, res) => {
  if (z.literal('DELETE').safeParse(req.body?.confirm).success === false) return res.status(400).json({ error: 'Type DELETE to confirm' });
  const auth = await reauthenticate(req, uid(res), 'delete your account');
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error, code: auth.code });
  const deleted = await requestDeletion(uid(res));
  if (deleted) clearSessionCookie(res);
  res.json({ deleted });
});

// "I'm stuck": a message to the maintainer, whose address stays server-side.
deletionRouter.post('/me/contact', async (req, res) => {
  const body = z.object({ message: z.string().trim().min(5).max(2000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Write a message of 5 to 2000 characters' });
  if (!env.supportEmail) return res.status(503).json({ error: "Contact isn't set up on this server" });
  const me = uid(res);
  // Counted in the database: serverless instances share no memory
  if (!(await hit(`contact:user:${me}`, 1, 60_000))) return res.status(429).json({ error: 'Please wait a minute before sending another message' });
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
            JOIN bet_participants p ON p.bet_id = b.id AND p.user_id = ? AND p.status = 'joined'
            WHERE r.response = 'pending' AND r.requested_by != ? AND b.status IN ${ONGOING} ORDER BY r.created_at`,
      args: [me, me],
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
            JOIN bet_participants p ON p.bet_id = b.id AND p.user_id = ? AND p.status = 'joined'
            WHERE r.bet_id = ? AND r.response = 'pending' AND r.requested_by != ? AND b.status IN ${ONGOING}`,
      args: [me, req.params.id, me],
    }),
  );
  if (!r) return res.status(404).json({ error: 'There is no request to answer on this bet' });
  const now = Date.now();
  // Any one of the other players answers for all of them
  await db.execute({ sql: 'UPDATE bet_cancel_requests SET response = ?, responded_at = ? WHERE bet_id = ? AND requested_by = ?', args: [action === 'accept' ? 'accepted' : 'refused', now, req.params.id, r.requested_by] });
  if (action === 'accept') {
    await cancelBet(String(req.params.id));
    await afterBetEnded(String(req.params.id));
  }
  res.json({ ok: true });
});

// A settled bet whose every other player has since deleted their account can be dropped from the remaining player's history.
deletionRouter.post('/bets/:id/remove-from-history', async (req, res) => {
  const me = uid(res);
  const b = first(
    await db.execute({
      sql: `SELECT b.id FROM bets b JOIN bet_participants p ON p.bet_id = b.id AND p.user_id = ? AND p.status = 'joined'
            WHERE b.id = ? AND b.status = 'settled'
              AND EXISTS (SELECT 1 FROM bet_participants o JOIN users u ON u.id = o.user_id WHERE o.bet_id = b.id AND o.user_id != ? AND u.deleted_at IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM bet_participants o JOIN users u ON u.id = o.user_id WHERE o.bet_id = b.id AND o.user_id != ? AND o.status = 'joined' AND u.deleted_at IS NULL)`,
      args: [me, req.params.id, me, me],
    }),
  );
  if (!b) return res.status(404).json({ error: 'Only bets where everyone else has deleted their account can be removed from your history' });
  const placeholders = (await db.execute({ sql: 'SELECT o.user_id FROM bet_participants o JOIN users u ON u.id = o.user_id WHERE o.bet_id = ? AND u.deleted_at IS NOT NULL', args: [b.id] })).rows.map((r) => String(r.user_id));
  const stillUsed = `(SELECT 1 FROM bet_participants WHERE user_id = ?)`;
  await db.batch(
    [
      { sql: 'DELETE FROM bet_reminders WHERE bet_id = ?', args: [b.id] },
      { sql: 'DELETE FROM bet_settlements WHERE bet_id = ?', args: [b.id] },
      { sql: 'DELETE FROM bet_participants WHERE bet_id = ?', args: [b.id] },
      { sql: 'DELETE FROM bets WHERE id = ?', args: [b.id] },
      // The last bet with a placeholder takes the placeholder and its "friendship" with it
      ...placeholders.flatMap((ph) => [
        { sql: `DELETE FROM connections WHERE (user_a = ? OR user_b = ?) AND NOT EXISTS ${stillUsed}`, args: [ph, ph, ph] },
        { sql: `DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL AND NOT EXISTS ${stillUsed}`, args: [ph, ph] },
      ]),
    ],
    'write',
  );
  res.json({ ok: true });
});
