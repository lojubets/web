import { describeReading, readDuration } from '../../shared/duration';
import type { BetKind, BetParams, InstantParams, NumberParams } from '../../shared/types';
import { describeRules, toLocalInput } from '../format';
import Icon from './Icon';

interface Props {
  kind: BetKind;
  params: BetParams;
  value: string;
  onChange: (v: string) => void;
  label: string;
  /** 'outcome' answers describe something that already happened, so the bet's guess rules are not shown. */
  role?: 'guess' | 'outcome';
}

export default function ValueInput({ kind, params, value, onChange, label, role = 'guess' }: Props) {
  const hint = role === 'guess' ? describeRules(kind, params).join(' · ') : null;
  return (
    <label className="field">
      <span>{label}</span>
      {kind === 'number' && <NumberField params={params as NumberParams} value={value} onChange={onChange} role={role} />}
      {kind === 'duration' && <DurationField value={value} onChange={onChange} hint={hint} />}
      {kind === 'instant' && <InstantField params={params as InstantParams} value={value} onChange={onChange} role={role} />}
      {kind !== 'duration' && hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function NumberField({ params, value, onChange, role }: { params: NumberParams; value: string; onChange: (v: string) => void; role: string }) {
  // iOS's number keypads have no minus sign, so only use them when negatives are impossible.
  const nonNegative = role === 'guess' && params.min !== null && params.min >= 0;
  return (
    <input
      type="text"
      inputMode={nonNegative ? (params.integer ? 'numeric' : 'decimal') : undefined}
      placeholder={params.integer ? 'e.g. 3' : 'e.g. 2.5'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required
    />
  );
}

/**
 * One fixed-height slot under the field: the helper text while it's empty, then how the text was read, with
 * units spelled out, so "3m" can't silently become 3 minutes when 3 months was meant. Same height in every
 * state, so the form doesn't jump while you type.
 */
function DurationField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string | null }) {
  const typed = value.trim() !== '';
  const reading = typed ? readDuration(value) : null;
  const shown = reading && describeReading(reading);
  const state = !typed ? 'hint' : !reading ? 'error' : reading.bareM ? 'warn' : 'read';
  return (
    <>
      <input type="text" placeholder="e.g. 3:05, 25 days, 12 weeks" value={value} onChange={(e) => onChange(e.target.value)} required />
      <small className={`slot slot-${state}`} role="status" aria-live="polite">
        {state === 'hint' && hint}
        {state === 'error' && (
          <>
            <Icon name="alert" size={16} />
            <span>Can't read that as a duration. Try 3:05, 25 days or 3 months and 2 days.</span>
          </>
        )}
        {shown && (
          <>
            <Icon name={reading!.bareM ? 'alert' : 'check'} size={16} />
            <span>
              = <b>{shown.text}</b>
              {shown.total && ` (${shown.total} in total)`}
              {reading!.bareM && <> "m" means minutes. For months, write "months" or "mo".</>}
            </span>
          </>
        )}
      </small>
    </>
  );
}

/** Values travel as UTC ISO strings ('minute') or YYYY-MM-DD ('day'); the picker shows the viewer's local time. */
function InstantField({ params, value, onChange, role }: { params: InstantParams; value: string; onChange: (v: string) => void; role: string }) {
  const now = Date.now();
  const earliest = !params.allowPast && role === 'guess' ? now + params.minLeadMinutes * 60_000 : undefined;
  if (params.precision === 'day') {
    return (
      <input
        type="date"
        value={value}
        min={earliest === undefined ? undefined : toLocalInput(earliest).slice(0, 10)}
        max={role === 'outcome' ? toLocalInput(now).slice(0, 10) : undefined}
        onChange={(e) => onChange(e.target.value)}
        required
      />
    );
  }
  const d = value ? new Date(value) : null;
  return (
    <input
      type="datetime-local"
      value={d && !Number.isNaN(d.getTime()) ? toLocalInput(d.getTime()) : ''}
      min={earliest === undefined ? undefined : toLocalInput(earliest)}
      max={role === 'outcome' ? toLocalInput(now) : undefined}
      onChange={(e) => {
        const t = new Date(e.target.value);
        onChange(e.target.value && !Number.isNaN(t.getTime()) ? t.toISOString() : '');
      }}
      required
    />
  );
}
