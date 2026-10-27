import type { BetKind, BetStatus } from '../shared/types.js';
import { loadParams, tippingPoint, tippingVerdict } from './betLogic.js';
import { db } from './db.js';

export interface BetRow {
  id: string;
  creator_id: string;
  opponent_id: string;
  question: string;
  kind: BetKind;
  params: string | null;
  status: BetStatus;
  creator_guess: string;
  opponent_guess: string | null;
  outcome: string | null;
  outcome_proposed_by: string | null;
  winner_id: string | null;
  all_in: number;
  stake: number;
  created_at: number;
  settled_at: number | null;
  settled_by: string | null;
}

export const tippingPointOf = (b: BetRow): number | null =>
  b.opponent_guess === null ? null : tippingPoint(b.kind, loadParams(b.kind, b.params), b.creator_guess, b.opponent_guess);

/**
 * Settles in-play future-dated bets whose tipping point has passed. Safe to call any time: it only
 * touches 'active' bets (a pending outcome proposal must be confirmed or rejected first) and the
 * UPDATE is guarded, so concurrent callers can't settle twice.
 */
export async function settleDueBets(opts: { userId?: string; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const scope = opts.userId ? 'AND (creator_id = ? OR opponent_id = ?)' : '';
  const rows = (
    await db.execute({
      sql: `SELECT * FROM bets WHERE kind = 'instant' AND status = 'active' ${scope}`,
      args: opts.userId ? [opts.userId, opts.userId] : [],
    })
  ).rows as unknown as BetRow[];

  let settled = 0;
  for (const b of rows) {
    const tp = tippingPointOf(b);
    if (tp === null || now < tp) continue;
    const verdict = tippingVerdict(b.kind, b.creator_guess, b.opponent_guess!);
    const winner = verdict === 'draw' ? null : verdict === 'creator' ? b.creator_id : b.opponent_id;
    const r = await db.execute({
      sql: `UPDATE bets SET status = 'settled', winner_id = ?, settled_at = ?, settled_by = 'tipping_point' WHERE id = ? AND status = 'active'`,
      args: [winner, tp, b.id],
    });
    settled += r.rowsAffected;
  }
  return settled;
}
