import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { MergeChoices, MergePreview, MergeSide } from '../shared/types.js';
import { clearMergeTicket, devLoginAllowed, hashPassword, issueMergeTicket, readMergeTicket, revokeSessions, verifyPassword } from './auth.js';
import { db } from './db.js';
import { rateLimit } from './rateLimit.js';

/**
 * Merging account B into account A (the one you're signed in to):
 *  1. While signed in as A, prove you can sign in to B (password, provider or dev login). That yields a short-lived
 *     "merge ticket"; the session is never replaced.
 *  2. Preview both profiles, then choose whose email, display name and photo the merged account uses.
 *  3. Confirm: one transaction moves everything of B's to A and deletes B. Both addresses stay on record with their
 *     verification status, and every login method of either account now signs in to the merged account.
 * Both accounts must have a verified email, so nobody can merge into themselves an address they don't own.
 */

export const mergeRouter = Router();

type Row = Record<string, any>;
const first = (r: { rows: unknown[] }) => r.rows[0] as Row | undefined;
const uid = (res: Response): string => res.locals.userId;

async function loadSide(id: string): Promise<MergeSide | null> {
  const u = first(
    await db.execute({
      sql: `SELECT u.id, u.name, u.email, a.updated_at AS avatar_version FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?`,
      args: [id],
    }),
  );
  if (!u) return null;
  const emails = await db.execute({ sql: 'SELECT email, verified FROM user_emails WHERE user_id = ? ORDER BY created_at, email', args: [id] });
  const primary = String(u.email ?? '').toLowerCase();
  const list = emails.rows.map((e) => ({ email: String(e.email), verified: !!e.verified, primary: String(e.email) === primary }));
  list.sort((x, y) => Number(y.primary) - Number(x.primary));
  const friends = first(await db.execute({ sql: 'SELECT count(*) AS n FROM connections WHERE user_a = ? OR user_b = ?', args: [id, id] }))!.n;
  const bets = first(
    await db.execute({ sql: `SELECT count(*) AS n FROM bets b JOIN bet_participants p ON p.bet_id = b.id WHERE p.user_id = ? AND p.status IN ('invited', 'joined') AND b.status != 'cancelled'`, args: [id] }),
  )!.n;
  return {
    id,
    name: u.name || u.email || 'Friend',
    profileName: u.name ?? '',
    hasAvatar: u.avatar_version != null,
    avatarVersion: Number(u.avatar_version ?? 0),
    primaryEmail: u.email ?? null,
    emails: list,
    friends: Number(friends),
    bets: Number(bets),
  };
}

const primaryVerified = (s: MergeSide) => s.emails.some((e) => e.primary && e.verified);

/** Bets both accounts are in (or were asked into). */
const SHARED = `(SELECT x.bet_id FROM bet_participants x JOIN bet_participants y ON y.bet_id = x.bet_id
                 WHERE x.user_id = ? AND y.user_id = ? AND x.status IN ('invited', 'joined') AND y.status IN ('invited', 'joined'))`;

async function betsBetween(a: string, b: string) {
  const r = await db.execute({
    sql: `SELECT status, count(*) AS n FROM bets WHERE status != 'cancelled' AND id IN ${SHARED} GROUP BY status`,
    args: [a, b],
  });
  let unfinished = 0;
  let finished = 0;
  for (const row of r.rows) (row.status === 'settled' ? (finished += Number(row.n)) : (unfinished += Number(row.n)));
  return { unfinished, finished };
}

const hasPasswordLogin = async (id: string) =>
  !!first(await db.execute({ sql: `SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = 'password' LIMIT 1`, args: [id] }));

async function previewFor(a: string, b: string): Promise<MergePreview | null> {
  const [sa, sb] = await Promise.all([loadSide(a), loadSide(b)]);
  if (!sa || !sb) return null;
  const between = await betsBetween(a, b);
  const blockers: string[] = [];
  if (!primaryVerified(sa)) blockers.push('Verify the email address of this account first.');
  if (!primaryVerified(sb)) {
    blockers.push("The other account's email address isn't verified. Sign in to that account on its own, verify its email, then try again.");
  }
  if (between.unfinished > 0) {
    blockers.push(`You have ${between.unfinished} unfinished bet${between.unfinished === 1 ? '' : 's'} with each other. Finish or cancel ${between.unfinished === 1 ? 'it' : 'them'} first.`);
  }
  // One account can only have one password, so two password accounts need a new, shared one
  const needsNewPassword = (await hasPasswordLogin(a)) && (await hasPasswordLogin(b));
  return { a: sa, b: sb, blockers, betsBetween: between.finished, needsNewPassword };
}

/** The ticket for the signed-in account, or null (and the stale cookie is cleared). */
async function currentTicket(req: Request, res: Response) {
  const ticket = await readMergeTicket(req);
  if (!ticket || ticket.a !== uid(res)) {
    if (ticket) clearMergeTicket(res);
    return null;
  }
  return ticket;
}

async function startMerge(res: Response, b: string | null | undefined) {
  if (!b) return res.status(401).json({ error: "We couldn't sign in to that account" });
  if (b === uid(res)) return res.status(400).json({ error: "That's the account you're already signed in with" });
  await issueMergeTicket(res, uid(res), b);
  res.json({ ok: true });
}

// Step 1: prove you can sign in to the other account. (Providers do this through /api/auth/:provider?merge=1.)
mergeRouter.post('/password', rateLimit('merge-password', { perIp: 30, perBody: { field: 'email', max: 10 } }), async (req, res) => {
  const body = z.object({ email: z.email(), password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter the email and password of the other account' });
  return startMerge(res, await verifyPassword(body.data.email, body.data.password));
});

// Development only, so the flow can be tried without any OAuth setup.
mergeRouter.post('/dev', async (req, res) => {
  if (!devLoginAllowed(req)) return res.status(404).json({ error: 'Not found' });
  const body = z.object({ email: z.email() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'Enter an email' });
  const r = first(await db.execute({ sql: `SELECT user_id FROM identities WHERE provider = 'dev' AND subject = ?`, args: [body.data.email.toLowerCase()] }));
  return startMerge(res, r?.user_id);
});

mergeRouter.delete('/', (_req, res) => {
  clearMergeTicket(res);
  res.json({ ok: true });
});

// Step 2: both profiles side by side.
mergeRouter.get('/preview', async (req, res) => {
  const ticket = await currentTicket(req, res);
  if (!ticket) return res.status(404).json({ error: 'No merge in progress. Sign in to the other account first.' });
  const preview = await previewFor(ticket.a, ticket.b);
  if (!preview) {
    clearMergeTicket(res);
    return res.status(404).json({ error: 'That account no longer exists' });
  }
  res.json(preview);
});

// The other account isn't a friend, so its photo needs its own route (only while a merge is in progress).
mergeRouter.get('/avatar/:side', async (req, res) => {
  const ticket = await currentTicket(req, res);
  if (!ticket) return res.status(404).end();
  const id = req.params.side === 'a' ? ticket.a : req.params.side === 'b' ? ticket.b : null;
  const a = id && first(await db.execute({ sql: 'SELECT mime, data FROM avatars WHERE user_id = ?', args: [id] }));
  if (!a) return res.status(404).end();
  res.set('Cache-Control', 'private, no-store');
  res.type(a.mime).send(Buffer.from(a.data, 'base64'));
});

// Step 3: do it.
const choicesSchema = z.object({ email: z.enum(['a', 'b']), name: z.enum(['a', 'b']), photo: z.enum(['a', 'b', 'none']) });

mergeRouter.post('/confirm', async (req, res) => {
  const parsed = choicesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose which email address, display name and photo to keep' });
  const choices: MergeChoices = parsed.data;

  const ticket = await currentTicket(req, res);
  if (!ticket) return res.status(404).json({ error: 'No merge in progress. Sign in to the other account first.' });
  const { a, b } = ticket;
  const preview = await previewFor(a, b);
  if (!preview) return res.status(404).json({ error: 'That account no longer exists' });
  if (preview.blockers.length) return res.status(409).json({ error: preview.blockers[0] });

  let passwordHash: string | null = null;
  if (preview.needsNewPassword) {
    const pw = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'Choose a new password for the merged account (at least 8 characters)' });
    passwordHash = await hashPassword(pw);
  }

  const side = { a: preview.a, b: preview.b };
  const keep = side[choices.email];
  const nameFrom = side[choices.name];
  if (choices.photo !== 'none' && !side[choices.photo].hasAvatar) return res.status(400).json({ error: "That account doesn't have a photo" });

  const S = (sql: string, args: (string | number)[] = []) => ({ sql, args });
  // One transaction: either everything moves, or nothing does.
  await db.batch(
    [
      // A two-player bet between the two accounts would become a bet with yourself: it goes. (Unfinished ones were
      // ruled out above.) A bet with other players in it stays, with the merged account as one player: what the two
      // owed each other disappears, and what either owed (or was owed by) a third player adds up.
      S(`CREATE TEMP TABLE merge_gone AS SELECT id FROM bets WHERE id IN ${SHARED} AND (SELECT count(*) FROM bet_participants WHERE bet_id = bets.id AND status = 'joined') <= 2`, [a, b]),
      S(`DELETE FROM bet_reminders WHERE bet_id IN (SELECT id FROM merge_gone)`),
      S(`DELETE FROM bet_settlements WHERE bet_id IN (SELECT id FROM merge_gone)`),
      S(`DELETE FROM bet_participants WHERE bet_id IN (SELECT id FROM merge_gone)`),
      S(`DELETE FROM bets WHERE id IN (SELECT id FROM merge_gone)`),
      S('DROP TABLE merge_gone'),
      S('DELETE FROM bet_settlements WHERE (payer_id = ? AND payee_id = ?) OR (payer_id = ? AND payee_id = ?)', [a, b, b, a]),
      S(`UPDATE bet_settlements SET amount = amount + (SELECT amount FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payer_id = ? AND s.payee_id = bet_settlements.payee_id)
         WHERE payer_id = ? AND EXISTS (SELECT 1 FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payer_id = ? AND s.payee_id = bet_settlements.payee_id)`, [b, a, b]),
      S(`DELETE FROM bet_settlements WHERE payer_id = ? AND EXISTS (SELECT 1 FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payer_id = ? AND s.payee_id = bet_settlements.payee_id)`, [b, a]),
      S('UPDATE bet_settlements SET payer_id = ? WHERE payer_id = ?', [a, b]),
      S(`UPDATE bet_settlements SET amount = amount + (SELECT amount FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payee_id = ? AND s.payer_id = bet_settlements.payer_id)
         WHERE payee_id = ? AND EXISTS (SELECT 1 FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payee_id = ? AND s.payer_id = bet_settlements.payer_id)`, [b, a, b]),
      S(`DELETE FROM bet_settlements WHERE payee_id = ? AND EXISTS (SELECT 1 FROM bet_settlements s WHERE s.bet_id = bet_settlements.bet_id AND s.payee_id = ? AND s.payer_id = bet_settlements.payer_id)`, [b, a]),
      S('UPDATE bet_settlements SET payee_id = ? WHERE payee_id = ?', [a, b]),
      // One place per bet for the merged account: where A only declined (or was left out) but B is in, B's place is
      // the one that counts; otherwise A's is kept and B's goes. Whatever remains of B's becomes A's.
      S(`DELETE FROM bet_participants WHERE user_id = ? AND status IN ('declined', 'revoked')
         AND bet_id IN (SELECT bet_id FROM bet_participants WHERE user_id = ? AND status IN ('invited', 'joined'))`, [a, b]),
      S('DELETE FROM bet_participants WHERE user_id = ? AND bet_id IN (SELECT bet_id FROM bet_participants WHERE user_id = ?)', [b, a]),
      S('UPDATE bet_participants SET user_id = ? WHERE user_id = ?', [a, b]),
      S('UPDATE bets SET creator_id = ? WHERE creator_id = ?', [a, b]),
      S('UPDATE bets SET outcome_proposed_by = ? WHERE outcome_proposed_by = ?', [a, b]),
      // A pending freeform verdict naming B now names A (ids are UUIDs, so a plain replace is exact; a doubled id is read as one)
      S(`UPDATE bets SET proposed_winners = REPLACE(proposed_winners, ?, ?) WHERE proposed_winners LIKE ?`, [`"${b}"`, `"${a}"`, `%${b}%`]),
      // Friends: drop a connection between the two, then give B's friends to A (a mutual friend stays a single connection)
      S('DELETE FROM connections WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)', [a, b, b, a]),
      S(
        `INSERT OR IGNORE INTO connections (user_a, user_b, created_at)
         SELECT MIN(?, other), MAX(?, other), created_at
         FROM (SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS other, created_at FROM connections WHERE user_a = ? OR user_b = ?)`,
        [a, a, b, b, b],
      ),
      S('DELETE FROM connections WHERE user_a = ? OR user_b = ?', [b, b]),
      S('UPDATE invitations SET inviter_id = ? WHERE inviter_id = ?', [a, b]),
      // Every login method of B now signs in to A
      S('UPDATE identities SET user_id = ? WHERE user_id = ?', [a, b]),
      // Two password accounts become one account with one password: every password login gets the new one
      ...(passwordHash
        ? [S(`UPDATE password_credentials SET password_hash = ? WHERE subject IN (SELECT subject FROM identities WHERE provider = 'password' AND user_id = ?)`, [passwordHash, a])]
        : []),
      // Both addresses stay on record, each with its own verification status
      S('UPDATE user_emails SET verified = 1 WHERE user_id = ? AND email IN (SELECT email FROM user_emails WHERE user_id = ? AND verified = 1)', [a, b]),
      S('INSERT OR IGNORE INTO user_emails (user_id, email, verified, created_at) SELECT ?, email, verified, created_at FROM user_emails WHERE user_id = ?', [a, b]),
      S('DELETE FROM user_emails WHERE user_id = ?', [b]),
      // An invitation A sent to what is now one of A's own addresses is pointless
      S(`UPDATE invitations SET status = 'revoked' WHERE inviter_id = ? AND status = 'pending' AND lower(email) IN (SELECT email FROM user_emails WHERE user_id = ?)`, [a, a]),
      S('DELETE FROM email_verifications WHERE user_id = ?', [b]),
      // Profile: the chosen primary email and display name
      S('UPDATE users SET email = ?, email_verified = ?, name = ? WHERE id = ?', [
        keep.primaryEmail ?? '',
        keep.emails.find((e) => e.primary)?.verified ? 1 : 0,
        nameFrom.profileName,
        a,
      ]),
      // Photo
      ...(choices.photo === 'a' ? [] : [S('DELETE FROM avatars WHERE user_id = ?', [a])]),
      ...(choices.photo === 'b' ? [S('INSERT INTO avatars (user_id, mime, data, updated_at) SELECT ?, mime, data, ? FROM avatars WHERE user_id = ?', [a, Date.now(), b])] : []),
      S('DELETE FROM avatars WHERE user_id = ?', [b]),
      // B is gone; its sessions stop working
      S('DELETE FROM users WHERE id = ?', [b]),
    ],
    'write',
  );

  clearMergeTicket(res);
  // The account now has B's logins too: sign out every other session, keep this one.
  await revokeSessions(res, a);
  res.json({ ok: true });
});
