import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Bet, BetKind, Friend } from '../../shared/types';
import { api } from '../api';
import RulesEditor, { EMPTY_RULES, draftToParams, type RulesDraft } from '../components/RulesEditor';
import Icon from '../components/Icon';
import ValueInput from '../components/ValueInput';
import { useAction, useFetch } from '../hooks';

const KINDS: { kind: BetKind; title: string; hint: string }[] = [
  { kind: 'number', title: 'A number', hint: 'How many goals?' },
  { kind: 'duration', title: 'A duration', hint: 'How long will it take?' },
  { kind: 'instant', title: 'A date or time', hint: 'When will it happen?' },
  { kind: 'yesno', title: 'Yes or no', hint: 'Will Kane win the Ballon d\'Or?' },
  { kind: 'choice', title: 'Multiple choice', hint: 'Quit, fired or reassigned?' },
  { kind: 'text', title: 'Freeform', hint: 'What will Jose say?' },
];

export default function NewBet() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data: friends } = useFetch<Friend[]>('/friends');
  const [friendId, setFriendId] = useState(params.get('with') ?? '');
  const [kind, setKind] = useState<BetKind>('number');
  const [question, setQuestion] = useState('');
  const [guess, setGuess] = useState('');
  const [rules, setRules] = useState<RulesDraft>(EMPTY_RULES);
  const betParams = draftToParams(kind, rules);
  const { busy, error, run } = useAction();
  const selected = friendId || friends?.[0]?.id || '';

  return (
    <>
      <header className="header">
        <Link to="/" className="back"><Icon name="chevron-left" size={22} />Back</Link>
      </header>
      <h1>New bet</h1>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const bet = await api<Bet>('/bets', 'POST', { opponentId: selected, question, kind, params: betParams, guess });
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
        <div className="segmented three" role="radiogroup" aria-label="Answer type">
          {KINDS.map((k) => (
            <button type="button" key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'on' : ''} onClick={() => { setKind(k.kind); setGuess(''); }}>
              <strong>{k.title}</strong>
              <span className="small muted">{k.hint}</span>
            </button>
          ))}
        </div>
        <RulesEditor kind={kind} rules={rules} onChange={setRules} />
        <ValueInput key={kind} kind={kind} params={betParams} value={guess} onChange={setGuess} label="Your guess (optional, hidden until they answer)" optional />
        <small className="muted">Not sure yet? Leave it empty to record the bet now and guess later.</small>
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || !selected || (kind === 'choice' && (betParams as { options: string[] }).options.length < 2)}>{guess ? 'Propose bet' : 'Record bet'} · 1 GT</button>
      </form>
    </>
  );
}
