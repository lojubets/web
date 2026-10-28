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
  options: string[];
}

export const MAX_OPTIONS = 8;

export const EMPTY_RULES: RulesDraft = {
  integer: false, min: '', max: '', minExclusive: false, maxExclusive: false,
  precision: 'day', allowPast: false, leadAmount: '', leadUnit: 'hours', options: ['', ''],
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
  if (kind === 'choice') return { options: r.options.map((o) => o.trim()).filter(Boolean) } as BetParams;
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

  if (kind === 'text' || kind === 'yesno') return null;

  if (kind === 'choice') {
    const setOption = (i: number, v: string) => set({ options: rules.options.map((o, j) => (j === i ? v : o)) });
    return (
      <div className="card stack">
        <strong>Options</strong>
        {rules.options.map((o, i) => (
          <div className="bound" key={i}>
            <label className="field">
              <span className="sr-only">Option {i + 1}</span>
              <input value={o} maxLength={60} placeholder={`Option ${i + 1}`} onChange={(e) => setOption(i, e.target.value)} />
            </label>
            {rules.options.length > 2 && (
              <button type="button" className="link" aria-label={`Remove option ${i + 1}`} onClick={() => set({ options: rules.options.filter((_, j) => j !== i) })}>Remove</button>
            )}
          </div>
        ))}
        {rules.options.length < MAX_OPTIONS && (
          <button type="button" className="link" onClick={() => set({ options: [...rules.options, ''] })}>Add an option</button>
        )}
        <p className="muted small">If neither of you picks the right one, or you both do, it's a draw.</p>
      </div>
    );
  }

  if (kind === 'duration') {
    return (
      <div className="card accent stack">
        <strong>How to write a duration</strong>
        <ul className="examples">
          <li><span className="example">3:05</span> 3 hours 5 minutes</li>
          <li><span className="example">90 minutes</span> or <span className="example">1.5 hours</span></li>
          <li><span className="example">25 days</span></li>
          <li><span className="example">12 weeks</span></li>
          <li><span className="example">3 months and 2 days</span></li>
        </ul>
        <p className="muted small">
          Units: seconds, minutes, hours, days, weeks, months and years (or s, min, h, d, w, mo, y). A month counts as 30 days and a year as
          365. <b>m</b> means minutes. A bare number needs a unit.
        </p>
      </div>
    );
  }

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
