import type { BetKind } from '../shared/types';

export const beers = (n: number) => `${n} 🍺`;

export function balanceText(name: string, balance: number): string {
  if (balance === 0) return `You and ${name} are even`;
  return balance > 0 ? `${name} owes you ${beers(balance)}` : `You owe ${name} ${beers(-balance)}`;
}

export function formatValue(kind: BetKind, v: string | null): string {
  if (v === null) return '—';
  if (kind === 'number') return v;
  return new Date(`${v}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
