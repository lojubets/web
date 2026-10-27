import { z } from 'zod';
import { formatDurationLong, parseDuration } from '../shared/duration.js';
import type { BetKind, BetParams, InstantParams, NumberParams } from '../shared/types.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_ABS = 1e15;

const floorDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

// ---------- parameters ----------

const numberSchema = z
  .object({
    integer: z.boolean().default(false),
    min: z.number().finite().nullable().default(null),
    max: z.number().finite().nullable().default(null),
    minExclusive: z.boolean().default(false),
    maxExclusive: z.boolean().default(false),
  })
  .strict();

const instantSchema = z
  .object({
    precision: z.enum(['day', 'minute']).default('day'),
    allowPast: z.boolean().default(false),
    minLeadMinutes: z.number().int().min(0).max(525_600).default(0),
  })
  .strict();

const durationSchema = z.object({}).strict();

const schemas = { number: numberSchema, instant: instantSchema, duration: durationSchema } as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates the rules a bettor chose when creating a bet, filling in defaults. */
export function buildParams(kind: BetKind, input: unknown): Parsed<BetParams> {
  const parsed = schemas[kind].safeParse(input ?? {});
  if (!parsed.success) return { ok: false, error: 'Invalid bet rules' };
  const params = parsed.data as BetParams;

  if (kind === 'number') {
    const p = params as NumberParams;
    if (p.min !== null && p.max !== null) {
      // The smallest and largest answer that could actually be given must exist.
      const lo = p.integer ? (p.minExclusive ? Math.floor(p.min) + 1 : Math.ceil(p.min)) : p.min;
      const hi = p.integer ? (p.maxExclusive ? Math.ceil(p.max) - 1 : Math.floor(p.max)) : p.max;
      const empty = p.integer ? lo > hi : p.min >= p.max;
      if (empty) return { ok: false, error: 'The minimum and maximum leave no possible answers' };
    }
  }
  if (kind === 'instant') {
    const p = params as InstantParams;
    if (p.allowPast && p.minLeadMinutes > 0) return { ok: false, error: 'A minimum lead time only applies when past dates are not allowed' };
  }
  return { ok: true, value: params };
}

/** Reads rules stored with a bet, tolerating missing/old values. */
export function loadParams(kind: BetKind, stored: string | null): BetParams {
  let raw: unknown = {};
  try {
    raw = stored ? JSON.parse(stored) : {};
  } catch {}
  const parsed = schemas[kind].safeParse(raw);
  return (parsed.success ? parsed.data : schemas[kind].parse({})) as BetParams;
}

// ---------- answers ----------

export type AnswerRole = 'guess' | 'outcome';

/**
 * Validates and normalises an answer. Rules (whole numbers, bounds, lead time...) constrain guesses;
 * the real-world outcome only has to be well-formed, so a bet can never get stuck on an unexpected result.
 */
export function normalizeAnswer(kind: BetKind, params: BetParams, raw: string, ctx: { now: number; role: AnswerRole }): Parsed<string> {
  const fail = (error: string): Parsed<string> => ({ ok: false, error });
  const text = String(raw ?? '').trim();

  if (kind === 'number') {
    const p = params as NumberParams;
    const v = text.replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return fail('Enter a number');
    const n = Number(v);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_ABS) return fail('That number is too large');
    if (ctx.role === 'guess') {
      if (p.integer && !Number.isInteger(n)) return fail('Must be a whole number');
      if (p.min !== null && (p.minExclusive ? n <= p.min : n < p.min)) return fail(p.minExclusive ? `Must be greater than ${p.min}` : `Must be at least ${p.min}`);
      if (p.max !== null && (p.maxExclusive ? n >= p.max : n > p.max)) return fail(p.maxExclusive ? `Must be less than ${p.max}` : `Must be at most ${p.max}`);
    }
    return { ok: true, value: String(n) };
  }

  if (kind === 'duration') {
    const seconds = parseDuration(text);
    if (seconds === null) return fail('Enter a duration like 3:05, "25 days" or "3 months and 2 days"');
    return { ok: true, value: String(seconds) };
  }

  const p = params as InstantParams;
  let value: string;
  let t: number;
  if (p.precision === 'day') {
    t = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : NaN;
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== text) return fail('Enter a valid date');
    value = text;
  } else {
    t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(text) ? Date.parse(text) : NaN;
    if (Number.isNaN(t)) return fail('Enter a valid date and time');
    t = Math.floor(t / MIN_MS) * MIN_MS;
    value = new Date(t).toISOString();
  }

  if (ctx.role === 'guess' && !p.allowPast) {
    const earliest = ctx.now + p.minLeadMinutes * MIN_MS;
    const tooEarly = p.precision === 'day' ? t < floorDay(earliest) : t < earliest;
    if (tooEarly) {
      return fail(p.minLeadMinutes > 0 ? `Guess a time at least ${formatDurationLong(p.minLeadMinutes * 60)} from now` : "Dates in the past aren't allowed for this bet");
    }
  }
  if (ctx.role === 'outcome') {
    // The result is something that has already happened (day answers get a day of slack for time zones).
    const latest = p.precision === 'day' ? floorDay(ctx.now) + DAY_MS : ctx.now + 5 * MIN_MS;
    if (t > latest) return fail("The result can't be in the future");
  }
  return { ok: true, value };
}

/** Position of an answer on a number line, in the kind's own unit (number / seconds / epoch ms). */
function scalar(kind: BetKind, v: string): number {
  if (kind === 'instant') return v.length === 10 ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  return Number(v);
}

export type Verdict = 'creator' | 'opponent' | 'draw';

/** Whose guess was closer? Equal distance is a draw. */
export function decide(kind: BetKind, creatorGuess: string, opponentGuess: string, outcome: string): Verdict {
  const o = scalar(kind, outcome);
  // Rounded so decimal noise (0.1 + 0.2) can't turn a tie into a win.
  const dist = (g: string) => Math.round(Math.abs(scalar(kind, g) - o) * 1e9);
  const dc = dist(creatorGuess);
  const dop = dist(opponentGuess);
  if (dc === dop) return 'draw';
  return dc < dop ? 'creator' : 'opponent';
}

// ---------- tipping point ----------

/**
 * For a bet about a future event, the moment after which the winner is certain even though nothing
 * has happened: the outcome can only be later than "now", so once now is past the midpoint of the
 * two guesses, the later guess is closer whatever the outcome turns out to be.
 * Null for bets where the event may already have happened.
 */
export function tippingPoint(kind: BetKind, params: BetParams, guessA: string, guessB: string): number | null {
  const p = params as InstantParams;
  if (kind !== 'instant' || p.allowPast) return null;
  const mid = (scalar(kind, guessA) + scalar(kind, guessB)) / 2;
  // Day answers: the event could still happen today, so the midpoint must be before today starts.
  // Minute answers: a minute of slack for rounding.
  return p.precision === 'day' ? floorDay(mid) + DAY_MS : Math.floor(mid) + MIN_MS;
}

/** At the tipping point the later guess wins (identical guesses draw). */
export function tippingVerdict(kind: BetKind, creatorGuess: string, opponentGuess: string): Verdict {
  const c = scalar(kind, creatorGuess);
  const o = scalar(kind, opponentGuess);
  return c === o ? 'draw' : c > o ? 'creator' : 'opponent';
}

// ---------- balances ----------

export interface SettledBetLike {
  winnerId: string | null;
  stake: number;
}

/** Lonkeros `other` owes `me` across settled bets (negative: I owe them). */
export function balanceFor(me: string, bets: SettledBetLike[]): number {
  return bets.reduce((sum, b) => (b.winnerId === null ? sum : sum + (b.winnerId === me ? b.stake : -b.stake)), 0);
}
