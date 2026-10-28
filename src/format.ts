import { formatDurationLong } from '../shared/duration';
import type { BetKind, BetParams, ChoiceParams, InstantParams, NumberParams } from '../shared/types';

export { formatValue, formatMoment } from '../shared/format';

// The one place that decides how a count of Gin & Tonics reads ("1 GT", "3 GTs").
export const gts = (n: number) => `${n} ${n === 1 ? 'GT' : 'GTs'}`;

export function balanceText(name: string, balance: number): string {
  if (balance === 0) return `You and ${name} are even`;
  return balance > 0 ? `${name} owes you ${gts(balance)}` : `You owe ${name} ${gts(-balance)}`;
}

/** The rules of a bet as short phrases, e.g. ["Whole numbers only", "At least 0 and less than 10"]. */
export function describeRules(kind: BetKind, params: BetParams): string[] {
  if (kind === 'text') return ['A few words, judged by you and your friend afterwards'];
  if (kind === 'yesno') return ['Yes or no'];
  if (kind === 'choice') return [`One of: ${(params as ChoiceParams).options.join(', ')}`];
  if (kind === 'duration') return ['A duration, e.g. 3:05, 25 days or 3 months and 2 days'];
  if (kind === 'number') {
    const p = params as NumberParams;
    const out = [p.integer ? 'Whole numbers only' : 'Whole or decimal numbers'];
    const lo = p.min === null ? null : `${p.minExclusive ? 'more than' : 'at least'} ${p.min}`;
    const hi = p.max === null ? null : `${p.maxExclusive ? 'less than' : 'at most'} ${p.max}`;
    if (lo || hi) out.push([lo, hi].filter(Boolean).join(' and '));
    return out;
  }
  const p = params as InstantParams;
  const out = [p.precision === 'day' ? 'A date' : 'A date and time'];
  if (p.allowPast) out.push('Past dates allowed');
  else out.push(p.minLeadMinutes > 0 ? `At least ${formatDurationLong(p.minLeadMinutes * 60)} in the future when guessing` : 'Future only');
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC ISO timestamp -> value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
