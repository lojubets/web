import { formatMoment, formatValue } from '../shared/format.js';
import { latestGuessers, loadParams } from './betLogic.js';
import { guessersOf, loadBet, playersOf, proposalOf, proposedWinners, requiredAcceptors, settleBet, settleDeadline, tippingPointOf, type LoadedBet } from './bets.js';
import { db } from './db.js';
import { afterBetEnded } from './deletion.js';
import { sendMail } from './email.js';
import { env } from './env.js';

const SOON_MS = 48 * 3_600_000; // wider than the daily cron interval, so no tipping point or deadline slips through

interface Person {
  id: string;
  name: string;
  email: string | null; // only set when verified
}

/** Name and (verified) email of everyone in the bet. */
async function people(lb: LoadedBet): Promise<Map<string, Person>> {
  const ids = playersOf(lb).map((p) => p.user_id);
  if (!ids.length) return new Map();
  const r = await db.execute({
    sql: `SELECT id, COALESCE(NULLIF(name, ''), email, 'Friend') AS name, CASE WHEN email_verified = 1 THEN email END AS email FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
    args: ids,
  });
  return new Map((r.rows as unknown as Person[]).map((p) => [p.id, p]));
}

const names = (who: Map<string, Person>, ids: string[]) => ids.map((id) => who.get(id)?.name ?? 'Friend');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const possessive = (xs: string[]) => (xs.length === 1 ? `${xs[0]}'s guess is` : `the guesses of ${list(xs)} are`);

/** Records that a reminder was sent; false if it already had been (so overlapping runs can't double-send). */
async function claim(betId: string, kind: string): Promise<boolean> {
  const r = await db.execute({ sql: 'INSERT OR IGNORE INTO bet_reminders (bet_id, kind, sent_at) VALUES (?, ?, ?)', args: [betId, kind, Date.now()] });
  return r.rowsAffected === 1;
}

async function notify(lb: LoadedBet, ids: string[], subject: string, body: (me: Person) => string) {
  const who = await people(lb);
  for (const id of ids) {
    const me = who.get(id);
    if (me?.email) await sendMail(me.email, subject, `${body(me)}\n\n${env.appUrl}/bets/${lb.bet.id}`);
  }
}

/** What the pending proposal says, in words. */
function describeProposal(lb: LoadedBet, who: Map<string, Person>): string {
  const b = lb.bet;
  const by = who.get(b.outcome_proposed_by!)?.name ?? 'A player';
  const kind = proposalOf(b);
  if (kind === 'tie') return `${by} proposes calling the bet off as a tie: nobody owes anything.`;
  const won = names(who, proposedWinners(lb) ?? []);
  if (kind === 'not_happened') return `${by} says the event still hasn't happened by the tipping point, which means ${list(won)} win${won.length === 1 ? 's' : ''}.`;
  const result = formatValue(b.kind, loadParams(b.kind, b.params), b.outcome, 'UTC');
  return `${by} says the result was ${result}${won.length ? `, which means ${list(won)} win${won.length === 1 ? 's' : ''}.` : ', which nobody wins: a draw.'}`;
}

/**
 * A proposal was made and it did not settle at once: the players whose acceptance it needs are told, and if the bet has
 * a deadline, that silence counts as acceptance once it passes.
 */
export async function notifyProposal(id: string) {
  const lb = await loadBet(id);
  if (!lb || lb.bet.status !== 'awaiting_confirmation') return;
  const deadline = settleDeadline(lb.bet);
  if (deadline === null) return; // Without a deadline, nothing happens by itself, and the app shows the proposal
  const who = await people(lb);
  const asked = requiredAcceptors(lb).filter((p) => !p.accepted).map((p) => p.user_id);
  await notify(lb, asked, `Result proposed: ${lb.bet.question}`, () =>
    `${describeProposal(lb, who)}\n\nOpen the bet to accept or reject it. If you haven't answered by ${new Date(deadline).toUTCString()}, it counts as accepted.`,
  );
}

export async function runCron(now = Date.now()) {
  // 1. Tipping point approaching
  const activeRows = (await db.execute(`SELECT id FROM bets WHERE kind = 'instant' AND status = 'active'`)).rows;
  const active = (await Promise.all(activeRows.map((r) => loadBet(String(r.id))))).filter((x): x is LoadedBet => !!x);
  let soon = 0;
  for (const lb of active) {
    const b = lb.bet;
    const tp = tippingPointOf(lb);
    if (tp === null || tp <= now || tp - now > SOON_MS || !(await claim(b.id, 'tipping_soon'))) continue;
    const params = loadParams(b.kind, b.params);
    const guessers = guessersOf(lb);
    const latest = latestGuessers(b.kind, guessers);
    const who = await people(lb);
    const guess = formatValue(b.kind, params, guessers.find((g) => g.id === latest[0])!.guess, 'UTC');
    await notify(lb, playersOf(lb).map((p) => p.user_id), `⏰ Tipping point approaching: ${b.question}`, () =>
      `Tipping point: ${formatMoment(tp, params, 'UTC')} UTC.\n\n` +
      `If the event still hasn't happened by then, ${possessive(names(who, latest))} (${guess}) guaranteed to be closest.\n` +
      `You'll be asked to confirm that. If the event has already happened, open the bet and enter the result.`,
    );
    soon++;
  }

  // 2. Tipping point passed: ask whether the event has happened (nothing is assumed)
  let passed = 0;
  for (const lb of active) {
    const b = lb.bet;
    const tp = tippingPointOf(lb);
    if (tp === null || tp > now || !(await claim(b.id, 'tipping_passed'))) continue;
    const params = loadParams(b.kind, b.params);
    const latest = names(await people(lb), latestGuessers(b.kind, guessersOf(lb)));
    await notify(lb, playersOf(lb).map((p) => p.user_id), `Has it happened yet? ${b.question}`, () =>
      `The tipping point (${formatMoment(tp, params, 'UTC')} UTC) has passed.\n\n` +
      `If the event happened, enter the result in the app. If it still hasn't, say so there: once the others agree, ${list(latest)} win${latest.length === 1 ? 's' : ''}.`,
    );
    passed++;
  }

  // 3. Proposals with a deadline: a reminder shortly before it, then silence counts as acceptance
  const pendingRows = (await db.execute(`SELECT id FROM bets WHERE status = 'awaiting_confirmation' AND settle_days IS NOT NULL AND proposed_at IS NOT NULL`)).rows;
  let deadlineReminders = 0;
  let settledByDeadline = 0;
  for (const row of pendingRows) {
    const lb = await loadBet(String(row.id));
    if (!lb) continue;
    const deadline = settleDeadline(lb.bet);
    if (deadline === null) continue;
    const waitingOn = requiredAcceptors(lb).filter((p) => !p.accepted).map((p) => p.user_id);
    if (now >= deadline) {
      // Settling is a single conditional write, so overlapping runs can't settle (and email) twice; a run that fails
      // before it leaves nothing behind, and the next one tries again
      if (!(await settleBet(lb, { now, byDeadline: true }))) continue;
      await afterBetEnded(lb.bet.id);
      const who = await people(lb);
      await notify(lb, playersOf(lb).map((p) => p.user_id), `Settled: ${lb.bet.question}`, () =>
        `${describeProposal(lb, who)}\n\nThe deadline passed without an answer from ${list(names(who, waitingOn))}, so the result now stands.`,
      );
      settledByDeadline++;
    } else if (deadline - now <= SOON_MS && lb.bet.settle_days! > 2 && waitingOn.length && (await claim(lb.bet.id, `deadline_soon:${lb.bet.proposed_at}`))) {
      const who = await people(lb);
      await notify(lb, waitingOn, `Reminder: ${lb.bet.question}`, () =>
        `${describeProposal(lb, who)}\n\nYou haven't answered yet. If you don't accept or reject it by ${new Date(deadline).toUTCString()}, it counts as accepted.`,
      );
      deadlineReminders++;
    }
  }

  return { remindersSent: soon, passedNotices: passed, deadlineReminders, settledByDeadline };
}
