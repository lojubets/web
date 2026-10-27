import type { BetKind } from '../../shared/types';

export default function ValueInput({ kind, value, onChange, label }: { kind: BetKind; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {kind === 'date' ? (
        <input type="date" value={value} onChange={(e) => onChange(e.target.value)} required />
      ) : (
        <input type="text" inputMode="decimal" placeholder="e.g. 3" value={value} onChange={(e) => onChange(e.target.value)} required />
      )}
    </label>
  );
}
