import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Bet, BetKind, Friend } from '../../shared/types';
import { api } from '../api';
import ValueInput from '../components/ValueInput';
import { useAction, useFetch } from '../hooks';

const KINDS: { kind: BetKind; title: string; hint: string }[] = [
  { kind: 'number', title: 'A number', hint: 'e.g. how many goals?' },
  { kind: 'date', title: 'A date', hint: 'e.g. when will it happen?' },
];

export default function NewBet() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data: friends } = useFetch<Friend[]>('/friends');
  const [friendId, setFriendId] = useState(params.get('with') ?? '');
  const [kind, setKind] = useState<BetKind>('number');
  const [question, setQuestion] = useState('');
  const [guess, setGuess] = useState('');
  const { busy, error, run } = useAction();
  const selected = friendId || friends?.[0]?.id || '';

  return (
    <>
      <header className="header">
        <Link to="/" className="back">‹ Back</Link>
        <h1>New bet</h1>
      </header>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const bet = await api<Bet>('/bets', 'POST', { opponentId: selected, question, kind, guess });
            nav(`/bets/${bet.id}`);
          });
        }}
      >
        <label className="field">
          <span>Bet with</span>
          <select value={selected} onChange={(e) => setFriendId(e.target.value)}>
            {friends?.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Question</span>
          <input value={question} maxLength={200} placeholder="When will Infantino resign?" onChange={(e) => setQuestion(e.target.value)} required />
        </label>
        <div className="segmented" role="radiogroup" aria-label="Answer type">
          {KINDS.map((k) => (
            <button type="button" key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => { setKind(k.kind); setGuess(''); }}>
              <strong>{k.title}</strong>
              <span className="small muted">{k.hint}</span>
            </button>
          ))}
        </div>
        <ValueInput kind={kind} value={guess} onChange={setGuess} label="Your guess (hidden until they answer)" />
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || !selected}>Propose bet · 1 🍺</button>
      </form>
    </>
  );
}
