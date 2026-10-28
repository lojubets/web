import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Bet, Friend } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import ValueInput from '../components/ValueInput';
import { describeRules, formatMoment, formatValue, lonkeros } from '../format';
import { useAction, useFetch } from '../hooks';

export default function BetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const bet = useFetch<Bet>(`/bets/${id}`);
  const friends = useFetch<Friend[]>('/friends');
  const act = useAction();
  const [value, setValue] = useState('');
  const [countering, setCountering] = useState(false);
  const [winner, setWinner] = useState<'me' | 'them' | 'draw' | ''>('');
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
      setWinner('');
      setCountering(false);
    });

  const fv = (v: string | null) => formatValue(b.kind, b.params, v);
  const later = b.kind === 'instant' && b.myGuess !== null && b.theirGuess !== null ? (b.myGuess > b.theirGuess ? 'me' : b.myGuess < b.theirGuess ? 'them' : 'both') : null;
  const byTipping = b.settledBy === 'tipping_point';
  const iWon = b.winnerId !== null && b.winnerId !== b.otherUserId;

  const withdraw = (
    <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/withdraw')}>Withdraw my proposal</button>
  );

  const proposeForm = (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/propose', { outcome: value, winner }); }}>
      <ValueInput kind={b.kind} params={b.params} role="outcome" value={value} onChange={setValue} label={b.status === 'active' ? 'It happened! What was the actual result?' : 'What was the actual result?'} />
      {b.kind === 'text' && (
        <fieldset className="field choices">
          <legend>Who was right?</legend>
          {([['me', 'I was'], ['them', `${friend.name} was`], ['draw', 'Neither, or both']] as const).map(([v, label]) => (
            <label key={v} className="check"><input type="radio" name="winner" checked={winner === v} onChange={() => setWinner(v)} required />{label}</label>
          ))}
        </fieldset>
      )}
      <button className="btn" disabled={act.busy}>Propose result</button>
      {b.status === 'active' && b.tippingPassed && later !== 'both' && (
        <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => post('/not-happened')}>
          It hasn't happened yet
        </button>
      )}
    </form>
  );

  return (
    <>
      <header className="header">
        <Link to="/" className="back"><Icon name="chevron-left" size={22} />Bets</Link>
      </header>
      <h1 className="question">{b.question}</h1>
      <Link to={`/friends/${friend.id}`} className="versus">
        <Avatar user={friend} size={28} /> vs {friend.name}
      </Link>

      <p className="muted small rules">{describeRules(b.kind, b.params).join(' · ')}</p>

      <div className="guesses">
        <div className="card guess">
          <span className="muted small">Your guess</span>
          <strong>{fv(b.myGuess)}</strong>
        </div>
        <div className="card guess">
          <span className="muted small">{friend.name}</span>
          {b.theirGuess === null ? <span className="hidden-guess"><Icon name="lock" size={18} />Hidden</span> : <strong>{fv(b.theirGuess)}</strong>}
        </div>
      </div>

      {b.tippingPoint !== null && b.status === 'active' && (
        <div className={`card stack ${b.tippingSoon || b.tippingPassed ? 'needs-action' : ''}`}>
          <strong className="row"><Icon name="clock" size={22} />{b.tippingPassed ? 'Tipping point passed' : 'Tipping point'}: {formatMoment(b.tippingPoint, b.params)}</strong>
          <span className="muted small">
            {later === 'both'
              ? 'You guessed the same, so this ends in a draw whatever happens.'
              : b.tippingPassed
                ? `Has the event happened? If it hasn't, ${later === 'me' ? 'your' : `${friend.name}'s`} guess is guaranteed to be closer.`
                : `If the event still hasn't happened by then, ${later === 'me' ? 'your' : `${friend.name}'s`} guess is guaranteed to be closer. You'll be asked to confirm. If it already happened, enter the result.`}
          </span>
        </div>
      )}

      {b.outcome !== null && (
        <div className="card guess">
          <span className="muted small">{b.status === 'settled' ? 'Outcome' : 'Proposed outcome'}</span>
          <strong>{fv(b.outcome)}</strong>
        </div>
      )}

      {b.allIn && <div className="banner banner-dare"><Icon name="flame" size={22} /><span>All-in: double or nothing for {lonkeros(b.stake)}</span></div>}

      {b.status === 'settled' && b.settledBy === 'tie' && (
        <div className="banner">
          <Icon name="check" size={22} />
          <span>Called off by agreement. Nobody owes anything.</span>
        </div>
      )}

      {b.status === 'settled' && b.settledBy !== 'tie' && (
        <div className={`banner ${b.winnerId === null ? '' : iWon ? 'banner-win' : 'banner-owe'}`}>
          <Icon name={iWon ? 'trophy' : 'can'} size={22} />
          <span>
          {byTipping && "You both confirmed the event hadn't happened by the tipping point. "}
          {b.winnerId === null
            ? "Dead heat, nobody owes anything."
            : iWon
              ? `You won ${lonkeros(b.stake)}! ${friend.name} owes you.`
              : `${friend.name} won. You owe ${lonkeros(b.stake)}.`}
          </span>
        </div>
      )}

      {b.status === 'awaiting_guess' && !b.iAmCreator && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/guess', { guess: value }); }}>
          <ValueInput kind={b.kind} params={b.params} value={value} onChange={setValue} label="Your guess" />
          <button className="btn" disabled={act.busy}>Lock in my guess</button>
          <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => act.run(async () => { await api(`/bets/${b.id}/cancel`, 'POST'); nav('/'); })}>
            Decline bet
          </button>
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

      {b.status === 'active' && proposeForm}

      {b.status === 'active' && (
        <div className="stack">
          <p className="muted small">Can't agree who was closer? Propose a tie. If {friend.name} agrees, the bet is called off and nobody owes anything.</p>
          <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/propose-tie')}>Propose a tie</button>
        </div>
      )}

      {b.status === 'awaiting_confirmation' &&
        (b.proposalKind === 'tie' ? (
          b.outcomeProposedByMe ? (
            <div className="stack">
              <p className="muted">Waiting for {friend.name} to agree to call the bet off as a tie.</p>
              {withdraw}
            </div>
          ) : (
            <div className="stack">
              <p>{friend.name} proposes a tie: call the bet off, and nobody owes anything. Agree?</p>
              <button className="btn" disabled={act.busy} onClick={() => post('/confirm')}>Yes, call it off</button>
              <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>No, keep it going</button>
            </div>
          )
        ) : b.proposalKind === 'not_happened' ? (
          b.outcomeProposedByMe ? (
            <div className="stack">
              <p className="muted">Waiting for {friend.name} to agree that the event hasn't happened yet.</p>
              {withdraw}
            </div>
          ) : (
            <div className="stack">
              <p>{friend.name} says the event still hasn't happened. If you agree, the later guess wins. Agree?</p>
              <button className="btn" disabled={act.busy} onClick={() => post('/confirm')}>Yes, it hasn't happened</button>
              <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>No, it has happened</button>
            </div>
          )
        ) : b.outcomeProposedByMe ? (
          <div className="stack">
            <p className="muted">Waiting for {friend.name} to confirm the result.</p>
            {withdraw}
          </div>
        ) : (
          <div className="stack">
            <p>
              {friend.name} says the result was <strong>{fv(b.outcome)}</strong>
              {b.proposedVerdict && ` and that ${b.proposedVerdict === 'me' ? 'you were' : b.proposedVerdict === 'them' ? 'they were' : 'neither of you was'} right`}. Agree?
            </p>
            <button className="btn" disabled={act.busy} onClick={() => post('/confirm')}>Confirm result</button>
            <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>That's not right</button>
            {countering ? (
              proposeForm
            ) : (
              <button className="btn btn-secondary" disabled={act.busy} onClick={() => setCountering(true)}>No, I say…</button>
            )}
          </div>
        ))}

      {b.status === 'settled' && friend.deleted && (
        <div className="stack">
          <p className="muted small">{friend.name} has left. This bet stays in your history until you remove it, which also changes your balance.</p>
          <button
            className="btn btn-secondary"
            disabled={act.busy}
            onClick={() => window.confirm('Remove this bet from your history? It is gone for good, and your balance changes if it was settled.') && act.run(async () => { await api(`/bets/${b.id}/remove-from-history`, 'POST'); nav('/'); })}
          >
            Remove from my history
          </button>
        </div>
      )}

      {b.canAllIn && (
        <div className="card allin-offer stack">
          <strong className="row"><Icon name="flame" size={22} />You're in the red. Feeling lucky?</strong>
          <span className="muted small">
            Go all-in: this bet is worth {lonkeros(b.allInStake)} instead of 1. Win and you're back to even, lose and you owe {lonkeros(b.allInStake * 2)}.
          </span>
          <button className="btn btn-danger" disabled={act.busy} onClick={() => confirm(`Double or nothing on ${lonkeros(b.allInStake)}?`) && post('/all-in')}>
            <Icon name="flame" size={20} />Go all-in
          </button>
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}
