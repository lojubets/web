import type { BetKind } from '../shared/types.js';

const DAY_MS = 86_400_000;

/** Validates and normalises a guess/outcome. Returns null if invalid. */
export function normalizeValue(kind: BetKind, raw: string): string | null {
  const v = raw.trim();
  if (kind === 'number') {
    if (v === '' || !Number.isFinite(Number(v))) return null;
    return String(Number(v));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
  return v;
}

function scalar(kind: BetKind, v: string): number {
  return kind === 'number' ? Number(v) : Date.parse(`${v}T00:00:00Z`) / DAY_MS;
}

export type Verdict = 'creator' | 'opponent' | 'draw';

/** Whose guess was closer? Equal distance is a draw. */
export function decide(kind: BetKind, creatorGuess: string, opponentGuess: string, outcome: string): Verdict {
  const o = scalar(kind, outcome);
  const dc = Math.abs(scalar(kind, creatorGuess) - o);
  const dop = Math.abs(scalar(kind, opponentGuess) - o);
  if (dc === dop) return 'draw';
  return dc < dop ? 'creator' : 'opponent';
}

export interface SettledBetLike {
  winnerId: string | null;
  stake: number;
}

/** Beers `other` owes `me` across settled bets (negative: I owe them). */
export function balanceFor(me: string, bets: SettledBetLike[]): number {
  return bets.reduce((sum, b) => (b.winnerId === null ? sum : sum + (b.winnerId === me ? b.stake : -b.stake)), 0);
}
