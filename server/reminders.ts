import { formatMoment, formatValue } from '../shared/format.js';
import { loadParams, tippingVerdict } from './betLogic.js';
import { tippingPointOf, type BetRow } from './bets.js';
import { db } from './db.js';
import { sendMail } from './email.js';
import { env } from './env.js';

const SOON_MS = 48 * 3_600_000; // wider than the daily cron interval, so no tipping point slips through

interface Person {
  id: string;
  name: string;
  email: string | null; // only set when verified
}

async function people(b: BetRow): Promise<{ creator: Person; opponent: Person }> {
  const r = await db.execute({
    sql: `SELECT id, name, CASE WHEN email_verified = 1 THEN email END AS email FROM users WHERE id IN (?, ?)`,
    args: [b.creator_id, b.opponent_id],
  });
  const by = new Map((r.rows as unknown as Person[]).map((p) => [p.id, p]));
  return { creator: by.get(b.creator_id)!, opponent: by.get(b.opponent_id)! };
}

/** Records that a reminder was sent; false if it already had been (so overlapping runs can't double-send). */
async function claim(betId: string, kind: string): Promise<boolean> {
  const r = await db.execute({ sql: 'INSERT OR IGNORE INTO bet_reminders (bet_id, kind, sent_at) VALUES (?, ?, ?)', args: [betId, kind, Date.now()] });
  return r.rowsAffected === 1;
}

async function notifyBoth(b: BetRow, subject: string, body: (me: Person, other: Person) => string) {
  const { creator, opponent } = await people(b);
  for (const [me, other] of [[creator, opponent], [opponent, creator]] as const) {
    if (me.email) await sendMail(me.email, subject, `${body(me, other)}\n\n${env.appUrl}/bets/${b.id}`);
  }
}

export async function runCron(now = Date.now()) {
  // 1. Tipping point approaching
  const active = (await db.execute(`SELECT * FROM bets WHERE kind = 'instant' AND status = 'active'`)).rows as unknown as BetRow[];
  let soon = 0;
  for (const b of active) {
    const tp = tippingPointOf(b);
    if (tp === null || tp <= now || tp - now > SOON_MS || !(await claim(b.id, 'tipping_soon'))) continue;
    const params = loadParams(b.kind, b.params);
    const laterIsCreator = tippingVerdict(b.kind, b.creator_guess, b.opponent_guess!) === 'creator';
    const { creator, opponent } = await people(b);
    const later = laterIsCreator ? creator : opponent;
    await notifyBoth(
      b,
      `⏰ Tipping point approaching: ${b.question}`,
      () =>
        `Tipping point: ${formatMoment(tp, params, 'UTC')} UTC.\n\n` +
        `If the event still hasn't happened by then, ${later.name}'s guess (${formatValue(b.kind, params, laterIsCreator ? b.creator_guess : b.opponent_guess, 'UTC')}) is guaranteed to be closer.\n` +
        `You'll be asked to confirm that. If the event has already happened, open the bet and enter the result.`,
    );
    soon++;
  }

  // 2. Tipping point passed: ask whether the event has happened (nothing is assumed)
  let passed = 0;
  for (const b of active) {
    const tp = tippingPointOf(b);
    if (tp === null || tp > now || !(await claim(b.id, 'tipping_passed'))) continue;
    const params = loadParams(b.kind, b.params);
    const laterIsCreator = tippingVerdict(b.kind, b.creator_guess, b.opponent_guess!) === 'creator';
    const { creator, opponent } = await people(b);
    const later = laterIsCreator ? creator : opponent;
    await notifyBoth(
      b,
      `Has it happened yet? ${b.question}`,
      () =>
        `The tipping point (${formatMoment(tp, params, 'UTC')} UTC) has passed.\n\n` +
        `If the event happened, enter the result in the app. If it still hasn't, say so there: once you both agree, ${later.name}'s guess wins.`,
    );
    passed++;
  }

  return { remindersSent: soon, passedNotices: passed };
}
