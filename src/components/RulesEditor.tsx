import { useEffect } from 'react';
import type { BetKind, BetParams } from '../../shared/types';

export interface RulesDraft {
  integer: boolean;
  min: string;
  max: string;
  minExclusive: boolean;
  maxExclusive: boolean;
  precision: 'day' | 'minute';
  allowPast: boolean;
  leadAmount: string;
  leadUnit: 'minutes' | 'hours' | 'days';
}

export const EMPTY_RULES: RulesDraft = {
  integer: false, min: '', max: '', minExclusive: false, maxExclusive: false,
  precision: 'day', allowPast: false, leadAmount: '', leadUnit: 'hours',
};

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 };
const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

export function draftToParams(kind: BetKind, r: RulesDraft): BetParams {
  if (kind === 'number') {
    return { integer: r.integer, min: num(r.min), max: num(r.max), minExclusive: r.minExclusive, maxExclusive: r.maxExclusive } as BetParams;
  }
  if (kind === 'instant') {
    const lead = r.allowPast ? 0 : Math.round((num(r.leadAmount) ?? 0) * UNIT_MINUTES[r.leadUnit]);
    return { precision: r.precision, allowPast: r.allowPast, minLeadMinutes: lead } as BetParams;
  }
  return {} as BetParams;
}

interface Props {
  kind: BetKind;
  rules: RulesDraft;
  onChange: (r: RulesDraft) => void;
}

export default function RulesEditor({ kind, rules, onChange }: Props) {
  const set = (patch: Partial<RulesDraft>) => onChange({ ...rules, ...patch });
  useEffect(() => {
    onChange({ ...EMPTY_RULES });
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  if (kind === 'duration') return <p className="muted small">Answers like <b>3:05</b> or <b>3 hours 5 minutes</b>.</p>;

  if (kind === 'number') {
    return (
      <div className="card stack">
        <label className="check"><input type="checkbox" checked={rules.integer} onChange={(e) => set({ integer: e.target.checked })} /> Whole numbers only</label>
        <div className="bound">
          <label className="field"><span>Minimum (optional)</span><input inputMode="text" placeholder="none" value={rules.min} onChange={(e) => set({ min: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={rules.minExclusive} disabled={!rules.min} onChange={(e) => set({ minExclusive: e.target.checked })} /> exclusive</label>
        </div>
        <div className="bound">
          <label className="field"><span>Maximum (optional)</span><input inputMode="text" placeholder="none" value={rules.max} onChange={(e) => set({ max: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={rules.maxExclusive} disabled={!rules.max} onChange={(e) => set({ maxExclusive: e.target.checked })} /> exclusive</label>
        </div>
        <button type="button" className="link" onClick={() => set({ min: '0', minExclusive: false })}>No negative numbers (minimum 0)</button>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="segmented two" role="radiogroup" aria-label="Precision">
        {(['day', 'minute'] as const).map((p) => (
          <button type="button" key={p} role="radio" aria-checked={rules.precision === p} className={rules.precision === p ? 'on' : ''} onClick={() => set({ precision: p })}>
            <strong>{p === 'day' ? 'Date' : 'Date & time'}</strong>
          </button>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={rules.allowPast} onChange={(e) => set({ allowPast: e.target.checked })} /> Allow dates in the past</label>
      {rules.allowPast ? (
        <p className="muted small">For things that may already have happened, like "when was it founded?".</p>
      ) : (
        <>
          <div className="bound">
            <label className="field"><span>Guesses must be at least this far ahead</span><input inputMode="decimal" placeholder="0" value={rules.leadAmount} onChange={(e) => set({ leadAmount: e.target.value })} /></label>
            <select aria-label="Unit" value={rules.leadUnit} onChange={(e) => set({ leadUnit: e.target.value as RulesDraft['leadUnit'] })}>
              <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
            </select>
          </div>
          <p className="muted small">
            Checked when each of you guesses, so nobody can guess "in 5 minutes" from the bleachers. Once the
            midpoint of your two guesses passes, you'll be asked whether the event has happened yet. If you both agree it hasn't, the later guess wins.
          </p>
        </>
      )}
    </div>
  );
}
