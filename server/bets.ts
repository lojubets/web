import type { BetKind, BetStatus } from '../shared/types.js';
import { loadParams, tippingPoint } from './betLogic.js';

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
  proposal: string | null;
}

/** The kind of the pending proposal (rows from before the column existed are inferred). */
export const proposalOf = (b: BetRow): 'outcome' | 'not_happened' | 'tie' | null =>
  b.status !== 'awaiting_confirmation' ? null : ((b.proposal as 'outcome' | 'not_happened' | 'tie' | null) ?? (b.outcome === null ? 'not_happened' : 'outcome'));

export const tippingPointOf = (b: BetRow): number | null =>
  b.opponent_guess === null ? null : tippingPoint(b.kind, loadParams(b.kind, b.params), b.creator_guess, b.opponent_guess);
