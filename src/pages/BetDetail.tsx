import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Bet, Friend } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import ValueInput from '../components/ValueInput';
import { beers, formatValue } from '../format';
import { useAction, useFetch } from '../hooks';

export default function BetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const bet = useFetch<Bet>(`/bets/${id}`);
  const friends = useFetch<Friend[]>('/friends');
  const act = useAction();
  const [value, setValue] = useState('');
  const b = bet.data;
  const friend = friends.data?.find((f) => f.id === b?.otherUserId);

  if (bet.error) return <p className="error">{bet.error}</p>;
  if (!b || !friend) return <p className="center muted">Loading…</p>;

  const post = (path: string, body?: unknown) =>
    act.run(async () => {
      await api(`/bets/${b.id}${path}`, 'POST', body ?? {});
      await bet.reload();
      await friends.reload();
      setValue('');
    });

  const fv = (v: string | null) => formatValue(b.kind, v);
  const iWon = b.winnerId !== null && b.winnerId !== b.otherUserId;

  return (
    <>
      <header className="header">
        <Link to="/" className="back">‹ Bets</Link>
      </header>
      <h1 className="question">{b.question}</h1>
      <Link to={`/friends/${friend.id}`} className="versus muted">
        <Avatar user={friend} size={28} /> vs {friend.name}
      </Link>

      <div className="guesses">
        <div className="card guess">
          <span className="muted small">Your guess</span>
          <strong>{fv(b.myGuess)}</strong>
        </div>
        <div className="card guess">
          <span className="muted small">{friend.name}</span>
          <strong>{b.theirGuess === null ? '🤫 hidden' : fv(b.theirGuess)}</strong>
        </div>
      </div>

      {b.outcome !== null && (
        <div className="card guess">
          <span className="muted small">{b.status === 'settled' ? 'Outcome' : 'Proposed outcome'}</span>
          <strong>{fv(b.outcome)}</strong>
        </div>
      )}

      {b.allIn && <p className="banner allin">🔥 All-in: double or nothing for {beers(b.stake)}</p>}

      {b.status === 'settled' && (
        <p className={`banner ${b.winnerId === null ? '' : iWon ? 'win' : 'lose'}`}>
          {b.winnerId === null
            ? "Dead heat, nobody owes anything."
            : iWon
              ? `You won ${beers(b.stake)}! ${friend.name} owes you.`
              : `${friend.name} won. You owe ${beers(b.stake)}.`}
        </p>
      )}

      {b.status === 'awaiting_guess' && !b.iAmCreator && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/guess', { guess: value }); }}>
          <ValueInput kind={b.kind} value={value} onChange={setValue} label="Your guess" />
          <button className="btn" disabled={act.busy}>Lock in my guess</button>
        </form>
      )}
      {b.status === 'awaiting_guess' && b.iAmCreator && (
        <>
          <p className="muted">Waiting for {friend.name} to guess.</p>
          <button className="btn btn-secondary" disabled={act.busy} onClick={() => act.run(async () => { await api(`/bets/${b.id}/cancel`, 'POST'); nav('/'); })}>
            Cancel bet
          </button>
        </>
      )}

      {b.status === 'active' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/propose', { outcome: value }); }}>
          <ValueInput kind={b.kind} value={value} onChange={setValue} label="It happened! What was the actual result?" />
          <button className="btn" disabled={act.busy}>Propose result</button>
        </form>
      )}

      {b.status === 'awaiting_confirmation' &&
        (b.outcomeProposedByMe ? (
          <p className="muted">Waiting for {friend.name} to confirm the result.</p>
        ) : (
          <div className="stack">
            <p>{friend.name} says the result was <strong>{fv(b.outcome)}</strong>. Agree?</p>
            <button className="btn" disabled={act.busy} onClick={() => post('/confirm')}>Confirm result</button>
            <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>That's not right</button>
          </div>
        ))}

      {b.canAllIn && (
        <div className="card allin-offer stack">
          <strong>You're in the red. Feeling lucky?</strong>
          <span className="muted small">
            Go all-in: this bet is worth {beers(b.allInStake)} instead of 1. Win and you're back to even, lose and you owe {beers(b.allInStake * 2)}.
          </span>
          <button className="btn btn-danger" disabled={act.busy} onClick={() => confirm(`Double or nothing on ${beers(b.allInStake)}?`) && post('/all-in')}>
            🔥 Go all-in
          </button>
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}
