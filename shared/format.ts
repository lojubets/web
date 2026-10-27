import { formatDurationLong } from './duration.js';
import type { BetKind, BetParams, InstantParams } from './types.js';

/** Human-readable answer. Pass timeZone 'UTC' on the server; the browser uses the viewer's zone. */
export function formatValue(kind: BetKind, params: BetParams, v: string | null, timeZone?: string): string {
  if (v === null) return '—';
  if (kind === 'number') return v;
  if (kind === 'duration') return formatDurationLong(Number(v));
  if ((params as InstantParams).precision === 'day') {
    return new Date(`${v}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
}

export function formatMoment(ms: number, params: BetParams, timeZone?: string): string {
  return (params as InstantParams).precision === 'day'
    ? formatValue('instant', params, new Date(ms).toISOString().slice(0, 10), timeZone)
    : formatValue('instant', params, new Date(ms).toISOString(), timeZone);
}
