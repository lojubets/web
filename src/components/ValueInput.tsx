import { parseDuration, formatDuration } from '../../shared/duration';
import type { BetKind, BetParams, InstantParams, NumberParams } from '../../shared/types';
import { describeRules, toLocalInput } from '../format';

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
      {kind === 'duration' && <DurationField value={value} onChange={onChange} />}
      {kind === 'instant' && <InstantField params={params as InstantParams} value={value} onChange={onChange} role={role} />}
      {hint && <small className="muted">{hint}</small>}
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

function DurationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const seconds = value.trim() ? parseDuration(value) : null;
  return (
    <>
      <input type="text" placeholder="3:05 or 3 hours 5 minutes" value={value} onChange={(e) => onChange(e.target.value)} required />
      {value.trim() && <small className={seconds === null ? 'error' : 'muted'}>{seconds === null ? "Can't read that as a duration" : `= ${formatDuration(seconds)}`}</small>}
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
