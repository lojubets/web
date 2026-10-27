// A month is counted as 30 days and a year as 365, so every duration is an exact number of seconds.
// ("m" is minutes; months must be spelled out or written "mo".)
export type DurationUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

const UNIT_TABLE: [DurationUnit, number, string[]][] = [
  ['year', 31536000, ['y', 'yr', 'yrs', 'year', 'years']],
  ['month', 2592000, ['mo', 'mos', 'month', 'months']],
  ['week', 604800, ['w', 'wk', 'wks', 'week', 'weeks']],
  ['day', 86400, ['d', 'day', 'days']],
  ['hour', 3600, ['h', 'hr', 'hrs', 'hour', 'hours']],
  ['minute', 60, ['m', 'min', 'mins', 'minute', 'minutes']],
  ['second', 1, ['s', 'sec', 'secs', 'second', 'seconds']],
];
const UNITS = new Map(UNIT_TABLE.flatMap(([unit, seconds, names]) => names.map((n) => [n, { unit, seconds }] as const)));
const SECONDS_PER = Object.fromEntries(UNIT_TABLE.map(([unit, seconds]) => [unit, seconds])) as Record<DurationUnit, number>;
const MAX_SECONDS = 100 * 365 * 86400;

export interface DurationPart {
  amount: number;
  unit: DurationUnit;
}

/** How a piece of text was understood: the exact seconds, and which amounts and units it was read as. */
export interface DurationReading {
  seconds: number;
  parts: DurationPart[];
  /** The text used a bare "m", which means minutes. Worth a second look: people often mean months. */
  bareM: boolean;
}

/**
 * Reads "3:05" (h:mm), "1:02:03" (h:mm:ss), or words: "3 hours and 5 minutes", "3h 5m", "1.5 hours",
 * "25 days", "12 weeks", "3 months and 2 days". Null if the text isn't a duration.
 */
export function readDuration(input: string): DurationReading | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const colon = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
  if (colon) {
    const [h, m, s] = [Number(colon[1]), Number(colon[2]), Number(colon[3] ?? 0)];
    if (m > 59 || s > 59) return null;
    const seconds = h * 3600 + m * 60 + s;
    if (seconds > MAX_SECONDS) return null;
    const parts: DurationPart[] = (
      [{ amount: h, unit: 'hour' }, { amount: m, unit: 'minute' }, { amount: s, unit: 'second' }] as DurationPart[]
    ).filter((p) => p.amount > 0);
    return { seconds, parts: parts.length ? parts : [{ amount: 0, unit: 'minute' }], bareM: false };
  }

  const parts: DurationPart[] = [];
  let seconds = 0;
  let bareM = false;
  const rest = text.replace(/(\d+(?:[.,]\d+)?)\s*([a-z]+)/g, (whole, num: string, name: string) => {
    const u = UNITS.get(name);
    if (!u) return whole; // left in place so the leftover check fails
    const amount = Number(num.replace(',', '.'));
    parts.push({ amount, unit: u.unit });
    seconds += amount * u.seconds;
    if (name === 'm') bareM = true;
    return ' ';
  });
  if (rest.replace(/\band\b|[,&\s]/g, '') !== '' || !/\d/.test(text)) return null;
  seconds = Math.round(seconds);
  return seconds <= MAX_SECONDS ? { seconds, parts, bareM } : null;
}

/** Whole seconds, or null if the text isn't a duration. */
export const parseDuration = (input: string): number | null => readDuration(input)?.seconds ?? null;

const num = (n: number) => String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);
const unitLabel = (amount: number, unit: DurationUnit) => `${num(amount)} ${unit}${amount === 1 ? '' : 's'}`;
const list = (items: string[]) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** 11100 -> "3 hours 5 minutes"; 92 days -> "92 days". Units are always spelled out. */
export function formatDurationLong(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s === 0) return '0 minutes';
  const out: string[] = [];
  let left = s;
  for (const unit of ['day', 'hour', 'minute', 'second'] as const) {
    const n = Math.floor(left / SECONDS_PER[unit]);
    left -= n * SECONDS_PER[unit];
    if (n) out.push(unitLabel(n, unit));
  }
  return out.join(' ');
}

/** What the user should see to confirm we read them right: "3 months and 2 days", and the total when units had to be converted. */
export function describeReading(r: DurationReading): { text: string; total: string | null } {
  const text = list(r.parts.map((p) => unitLabel(p.amount, p.unit)));
  const converted = r.parts.some((p) => ['year', 'month', 'week'].includes(p.unit) || !Number.isInteger(p.amount));
  return { text, total: converted ? formatDurationLong(r.seconds) : null };
}
