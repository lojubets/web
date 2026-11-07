import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MAX_PLAYERS, MAX_SETTLE_DAYS, type Bet, type BetKind } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import RulesEditor, { EMPTY_RULES, draftToParams, type RulesDraft } from '../components/RulesEditor';
import Icon from '../components/Icon';
import ValueInput from '../components/ValueInput';
import { useAction, useFriends } from '../hooks';
import { putBet } from '../store';
import { initialPick } from './newBetPick';

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
  const { data: friends } = useFriends();
  // null until the user touches the list; until then `initialPick` decides who starts out ticked
  const [picked, setPicked] = useState<string[] | null>(null);
  const [kind, setKind] = useState<BetKind>('number');
  const [question, setQuestion] = useState('');
  const [guess, setGuess] = useState('');
  const [rules, setRules] = useState<RulesDraft>(EMPTY_RULES);
  const [settleDays, setSettleDays] = useState<number | null>(null);
  const betParams = draftToParams(kind, rules);
  const { busy, error, run } = useAction();
  const available = friends?.filter((f) => !f.deleted) ?? [];
  const chosen = picked === null ? initialPick(available.map((f) => f.id), params.get('with')) : picked.filter((id) => available.some((f) => f.id === id));
  const group = chosen.length >= 2;
  const toggle = (id: string) => setPicked(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const full = chosen.length + 1 >= MAX_PLAYERS;

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
            const bet = await api<Bet>('/bets', 'POST', { opponentIds: chosen, question, kind, params: betParams, guess, settleDays: group ? settleDays : null });
            putBet(bet);
            nav(`/bets/${bet.id}`);
          });
        }}
      >
        <fieldset className="field choices">
          <legend>Bet with</legend>
          {available.map((f) => {
            const on = chosen.includes(f.id);
            return (
              <label key={f.id} className="check player-pick">
                <input type="checkbox" checked={on} disabled={!on && full} onChange={() => toggle(f.id)} />
                <Avatar user={f} size={28} />
                {f.name}
              </label>
            );
          })}
          <small className="muted">
            {group
              ? `A ${chosen.length + 1}-way bet. Everyone who doesn't win owes each winner 1 GT; a sole winner collects ${chosen.length} GTs. Joining makes the players friends with each other.`
              : `Pick more than one friend for a group bet (up to ${MAX_PLAYERS} players).`}
          </small>
        </fieldset>
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
        <ValueInput key={kind} kind={kind} params={betParams} value={guess} onChange={setGuess} label={`Your guess (optional, hidden until ${group ? 'the bet starts' : 'they answer'})`} optional />
        <small className="muted">Not sure yet? Leave it empty to record the bet now and guess later.</small>
        {group && (
          <label className="field">
            <span>If someone never answers a proposed result</span>
            <select value={settleDays ?? ''} onChange={(e) => setSettleDays(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">Wait for them, however long it takes</option>
              {Array.from({ length: MAX_SETTLE_DAYS }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>Count their silence as confirmation after {d} {d === 1 ? 'day' : 'days'}</option>
              ))}
            </select>
            <small>A result settles once everyone except the proposer and a sole winner has confirmed it. With a deadline, players are emailed when a result is proposed and again before it passes.</small>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy || chosen.length === 0 || (kind === 'choice' && (betParams as { options: string[] }).options.length < 2)}>
          {group ? `Propose ${chosen.length + 1}-way bet` : 'Propose bet · 1 GT'}
        </button>
      </form>
    </>
  );
}
