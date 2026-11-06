import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Bet, Friend, Participant } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import ValueInput from '../components/ValueInput';
import { describeRules, formatMoment, formatValue, gts, listNames } from '../format';
import { useAction, useFetch } from '../hooks';

const names = (ps: Participant[]) => listNames(ps.map((p) => (p.isMe ? 'you' : p.name)));
const Names = ({ of }: { of: Participant[] }) => <>{names(of)}</>;
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function BetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const bet = useFetch<Bet>(`/bets/${id}`);
  const friends = useFetch<Friend[]>('/friends');
  const act = useAction();
  const [value, setValue] = useState('');
  const [countering, setCountering] = useState(false);
  const [winners, setWinners] = useState<string[]>([]);
  const b = bet.data;

  if (bet.error) return <p className="error">{bet.error}</p>;
  if (!b || !friends.data) return <p className="center muted">Loading…</p>;

  const post = (path: string, body?: unknown) =>
    act.run(async () => {
      await api(`/bets/${b.id}${path}`, 'POST', body ?? {});
      await bet.reload();
      await friends.reload();
      setValue('');
      setWinners([]);
      setCountering(false);
    });
  const leave = (path: string) => act.run(async () => { await api(`/bets/${b.id}${path}`, 'POST'); nav('/'); });

  const fv = (v: string | null) => formatValue(b.kind, b.params, v);
  const me = b.participants.find((p) => p.isMe)!;
  const started = b.status !== 'awaiting_guess';
  const inGame = me.status === 'joined';
  const inBet = (p: Participant) => p.status === 'joined' || (p.status === 'invited' && !started);
  const players = b.participants.filter((p) => p.status === 'joined');
  const shown = b.participants.filter((p) => inBet(p) || (!started && p.status === 'declined'));
  // The other people in the bet: players, and before the start those still deciding
  const them = b.participants.filter((p) => inBet(p) && !p.isMe);
  const inBetCount = b.participants.filter(inBet).length;
  const two = inBetCount === 2 && inGame;
  const friendOf = (p: Participant) => friends.data!.find((f) => f.id === p.id);
  const creator = b.participants.find((p) => p.isCreator)!;
  const proposer = b.participants.find((p) => p.id === b.outcomeProposedBy);
  const winnersNow = b.participants.filter((p) => p.winner);
  const waitingOn = b.participants.filter((p) => p.mustAccept && !p.accepted);
  const iWon = me.winner;
  // Future-dated bets: whose guess is latest (and so certain to be closest once the tipping point passes)
  const latestGuess = b.kind === 'instant' && players.every((p) => p.guess !== null) ? players.map((p) => p.guess!).sort().at(-1)! : null;
  const latest = latestGuess === null ? [] : players.filter((p) => p.guess === latestGuess);
  const allSame = latest.length === players.length && players.length > 0;
  const byTipping = b.settledBy === 'tipping_point';
  const deleted = them.length > 0 && them.every((p) => p.deleted);

  const withdraw = (
    <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/withdraw')}>Withdraw my proposal</button>
  );

  const proposeForm = (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/propose', { outcome: value, winners }); }}>
      <ValueInput kind={b.kind} params={b.params} role="outcome" value={value} onChange={setValue} label={b.status === 'active' ? 'It happened! What was the actual result?' : 'What was the actual result?'} />
      {b.kind === 'text' && (
        <fieldset className="field choices">
          <legend>Who was right? {players.length > 2 && <span className="muted">(tick everyone who was, or nobody)</span>}</legend>
          {players.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={winners.includes(p.id)} onChange={() => setWinners(winners.includes(p.id) ? winners.filter((x) => x !== p.id) : [...winners, p.id])} />
              {p.isMe ? 'I was' : `${p.name} was`}
            </label>
          ))}
        </fieldset>
      )}
      <button className="btn" disabled={act.busy}>Propose result</button>
      {b.status === 'active' && b.tippingPassed && !allSame && (
        <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => post('/not-happened')}>
          It hasn't happened yet
        </button>
      )}
    </form>
  );

  const acceptance = (
    <ul className="accept-list">
      {b.participants.filter((p) => p.status === 'joined' && !p.isMe && p.id !== b.outcomeProposedBy).map((p) => (
        <li key={p.id} className={p.accepted ? 'ok' : p.mustAccept ? 'pending' : 'muted'}>
          <Icon name={p.accepted ? 'check' : p.mustAccept ? 'clock' : 'trophy'} size={16} />
          {p.name}: {p.accepted ? 'accepted' : p.mustAccept ? 'not answered yet' : 'wins outright, so not asked'}
        </li>
      ))}
    </ul>
  );

  const deadlineNote = b.settleDeadline && waitingOn.length > 0 && (
    <p className="muted small">
      If {names(waitingOn)} {waitingOn.length === 1 && !waitingOn[0].isMe ? "hasn't" : "haven't"} answered by {when(b.settleDeadline)}, that counts as accepting.
    </p>
  );

  const settledText = () => {
    if (winnersNow.length === 0) return 'Dead heat, nobody owes anything.';
    const owed = them.filter((p) => p.owesMe > 0);
    const owing = them.filter((p) => p.owesMe < 0);
    if (iWon) return `You won ${gts(b.myNet)}! ${listNames(owed.map((p) => p.name))} owe${owed.length === 1 ? 's' : ''} you${two || owed.length === 1 ? '' : ` ${gts(-owing[0]?.owesMe || owed[0].owesMe)} each`}.`;
    const w = winnersNow;
    return `${listNames(w.map((p) => p.name))} won. You owe ${w.length === 1 ? gts(-b.myNet) : `${gts(-b.myNet)}, ${gts(-owing[0].owesMe)} each`}.`;
  };

  return (
    <>
      <header className="header">
        <Link to="/" className="back"><Icon name="chevron-left" size={22} />Bets</Link>
      </header>
      <h1 className="question">{b.question}</h1>
      {two && friendOf(them[0]) ? (
        <Link to={`/friends/${them[0].id}`} className="versus">
          <Avatar user={them[0]} size={28} /> vs {them[0].name}
        </Link>
      ) : (
        <p className="versus">{inBetCount > 1 ? `${inBetCount}-way bet` : 'Group bet'} · started by {creator.isMe ? 'you' : creator.name}</p>
      )}

      <p className="muted small rules">{describeRules(b.kind, b.params).join(' · ')}</p>

      <div className="players">
        {shown.map((p) => (
          <div key={p.id} className={`card player ${p.winner && (b.status === 'settled' || b.status === 'awaiting_confirmation') ? 'player-win' : ''}`}>
            <Avatar user={p} size={36} />
            <div className="player-main">
              <span className="small muted">{p.isMe ? 'You' : friendOf(p) ? <Link to={`/friends/${p.id}`}>{p.name}</Link> : p.name}</span>
              {p.status === 'invited' ? (
                <span className="muted">Invited, not answered yet</span>
              ) : p.status === 'declined' ? (
                <span className="muted">Declined</span>
              ) : p.guess !== null ? (
                <strong>{fv(p.guess)}</strong>
              ) : p.guessIn ? (
                <span className="hidden-guess"><Icon name="lock" size={18} />Hidden until the bet starts</span>
              ) : b.status === 'settled' && p.deleted ? (
                <span className="muted">Guess removed</span>
              ) : (
                <span className="muted">Not guessed yet</span>
              )}
            </div>
            {b.status === 'settled' && p.winner && <span className="pill pill-positive"><Icon name="trophy" size={14} />Won</span>}
            {b.status === 'settled' && !p.isMe && p.owesMe > 0 && <span className="pill">owes you {gts(p.owesMe)}</span>}
            {b.status === 'settled' && !p.isMe && p.owesMe < 0 && <span className="pill">you owe {gts(-p.owesMe)}</span>}
            {b.status === 'awaiting_confirmation' && p.winner && <span className="pill pill-positive">Wins</span>}
          </div>
        ))}
      </div>

      {b.tippingPoint !== null && b.status === 'active' && (
        <div className={`card stack ${b.tippingSoon || b.tippingPassed ? 'needs-action' : ''}`}>
          <strong className="row"><Icon name="clock" size={22} />{b.tippingPassed ? 'Tipping point passed' : 'Tipping point'}: {formatMoment(b.tippingPoint, b.params)}</strong>
          <span className="muted small">
            {allSame
              ? 'You all guessed the same, so this ends in a draw whatever happens.'
              : b.tippingPassed
                ? `Has the event happened? If it hasn't, ${latest.length === 1 && latest[0].isMe ? 'your guess is' : `the guess of ${names(latest)} is`} guaranteed to be closest.`
                : `If the event still hasn't happened by then, ${latest.length === 1 && latest[0].isMe ? 'your guess is' : `the guess of ${names(latest)} is`} guaranteed to be closest. You'll be asked to confirm. If it already happened, enter the result.`}
          </span>
        </div>
      )}

      {b.outcome !== null && (
        <div className="card guess">
          <span className="muted small">{b.status === 'settled' ? 'Outcome' : 'Proposed outcome'}</span>
          <strong>{fv(b.outcome)}</strong>
        </div>
      )}

      {b.allIn && <div className="banner banner-dare"><Icon name="flame" size={22} /><span>All-in: double or nothing for {gts(b.stake)}</span></div>}

      {started && !inGame && (
        <div className="banner"><Icon name="alert" size={22} /><span>This bet {me.status === 'declined' ? 'went on' : 'started'} without you.</span></div>
      )}

      {b.status === 'settled' && inGame && b.settledBy === 'tie' && (
        <div className="banner">
          <Icon name="check" size={22} />
          <span>Called off by agreement. Nobody owes anything.</span>
        </div>
      )}

      {b.status === 'settled' && inGame && b.settledBy !== 'tie' && (
        <div className={`banner ${winnersNow.length === 0 ? '' : iWon ? 'banner-win' : 'banner-owe'}`}>
          <Icon name={iWon ? 'trophy' : 'glass'} size={22} />
          <span>
            {byTipping && "Everyone confirmed the event hadn't happened by the tipping point. "}
            {settledText()}
            {b.settledByDeadline && ' Settled when the deadline passed.'}
          </span>
        </div>
      )}

      {b.status === 'awaiting_guess' && me.status === 'invited' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/guess', { guess: value }); }}>
          <p>
            {creator.name} invites you to {inBetCount > 2 ? `a ${inBetCount}-way bet with ` : 'bet '}<Names of={them.filter((p) => !p.isCreator)} />
            {inBetCount > 2 ? '. Everyone who doesn\'t win owes each winner 1 GT. Joining makes you friends with the other players.' : '.'}
          </p>
          {them.some((p) => p.guessIn) && <p className="muted small">{listNames(them.filter((p) => p.guessIn).map((p) => p.name))} {them.filter((p) => p.guessIn).length === 1 ? 'has' : 'have'} locked in a guess.</p>}
          <ValueInput kind={b.kind} params={b.params} value={value} onChange={setValue} label="Your guess" />
          <button className="btn" disabled={act.busy}>{them.length > 1 ? 'Join with my guess' : 'Lock in my guess'}</button>
          <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => leave('/cancel')}>Decline bet</button>
        </form>
      )}
      {b.status === 'awaiting_guess' && me.status === 'joined' && b.myGuess === null && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); post('/guess', { guess: value }); }}>
          {them.some((p) => p.guessIn) && <p className="muted">{listNames(them.filter((p) => p.guessIn).map((p) => p.name))} {them.filter((p) => p.guessIn).length === 1 ? 'has' : 'have'} locked in a guess.</p>}
          <ValueInput kind={b.kind} params={b.params} value={value} onChange={setValue} label="Your guess" />
          <button className="btn" disabled={act.busy}>Lock in my guess</button>
          <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => leave('/cancel')}>{b.iAmCreator ? 'Cancel bet' : 'Back out'}</button>
        </form>
      )}
      {b.status === 'awaiting_guess' && me.status === 'joined' && b.myGuess !== null && (
        <div className="stack">
          <p className="muted">Waiting for <Names of={shown.filter((p) => inBet(p) && !p.guessIn)} /> to {shown.filter((p) => p.status === 'invited').length ? 'answer' : 'guess'}.</p>
          {b.canStart && (
            <>
              <p className="muted small">You can start the bet now with the {players.filter((p) => p.guessIn).length} of you who have guessed. Anyone who hasn't answered is left out.</p>
              <button className="btn" disabled={act.busy} onClick={() => post('/start')}>Start without them</button>
            </>
          )}
          <button className="btn btn-secondary" disabled={act.busy} onClick={() => leave('/cancel')}>{b.iAmCreator ? 'Cancel bet' : 'Back out'}</button>
        </div>
      )}
      {b.status === 'awaiting_guess' && me.status === 'declined' && <p className="muted">You declined this bet.</p>}

      {b.status === 'active' && inGame && proposeForm}

      {b.status === 'active' && inGame && (
        <div className="stack">
          <p className="muted small">Can't agree who was closest? Propose a tie. If {two ? them[0].name : 'everyone else'} agrees, the bet is called off and nobody owes anything.</p>
          <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/propose-tie')}>Propose a tie</button>
        </div>
      )}

      {b.status === 'awaiting_confirmation' && inGame && (
        <div className="stack">
          <p>
            {b.proposalKind === 'tie' ? (
              <>{proposer?.isMe ? 'You propose' : `${proposer?.name} proposes`} a tie: call the bet off, and nobody owes anything.</>
            ) : b.proposalKind === 'not_happened' ? (
              <>{proposer?.isMe ? 'You say' : `${proposer?.name} says`} the event still hasn't happened, which means <Names of={winnersNow} /> win{winnersNow.length === 1 && !winnersNow[0].isMe ? 's' : ''}.</>
            ) : (
              <>
                {proposer?.isMe ? 'You say' : `${proposer?.name} says`} the result was <strong>{fv(b.outcome)}</strong>
                {winnersNow.length === 0 ? ', a draw: nobody wins' : <>, which means <Names of={winnersNow} /> win{winnersNow.length === 1 && !winnersNow[0].isMe ? 's' : ''}</>}.
              </>
            )}
          </p>
          {!two && acceptance}
          {deadlineNote}
          {b.outcomeProposedByMe ? (
            <>
              <p className="muted">Waiting for <Names of={waitingOn} /> to {b.proposalKind === 'outcome' ? 'accept' : 'agree'}.</p>
              {withdraw}
            </>
          ) : b.iMustAccept && !b.iAccepted ? (
            <>
              <button className="btn" disabled={act.busy} onClick={() => post('/confirm', { proposal: b.proposalId })}>
                {b.proposalKind === 'tie' ? 'Yes, call it off' : b.proposalKind === 'not_happened' ? "Yes, it hasn't happened" : 'Accept the result'}
              </button>
              <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>
                {b.proposalKind === 'tie' ? 'No, keep it going' : b.proposalKind === 'not_happened' ? 'No, it has happened' : "That's not right"}
              </button>
              {b.proposalKind === 'outcome' && (countering ? proposeForm : <button className="btn btn-secondary" disabled={act.busy} onClick={() => setCountering(true)}>No, I say…</button>)}
            </>
          ) : (
            <>
              <p className="muted">
                {b.iAccepted ? 'You accepted. ' : iWon ? 'You win under this result, so your acceptance isn\'t needed. ' : ''}
                Waiting for <Names of={waitingOn} />.{b.iAccepted && ' Changed your mind? You can still reject it.'}
              </p>
              <button className="btn btn-secondary" disabled={act.busy} onClick={() => post('/reject')}>That's not right</button>
            </>
          )}
        </div>
      )}

      {b.status === 'settled' && deleted && (
        <div className="stack">
          <p className="muted small">{listNames(them.map((p) => p.name))} {them.length === 1 ? 'has' : 'have'} left. This bet stays in your history until you remove it, which also changes your balance.</p>
          <button
            className="btn btn-secondary"
            disabled={act.busy}
            onClick={() => window.confirm('Remove this bet from your history? It is gone for good, and your balance changes if it was settled.') && leave('/remove-from-history')}
          >
            Remove from my history
          </button>
        </div>
      )}

      {b.canAllIn && (
        <div className="card allin-offer stack">
          <strong className="row"><Icon name="flame" size={22} />You're in the red. Feeling lucky?</strong>
          <span className="muted small">
            Go all-in: this bet is worth {gts(b.allInStake)} instead of 1. Win and you're back to even, lose and you owe {gts(b.allInStake * 2)}.
          </span>
          <button className="btn btn-danger" disabled={act.busy} onClick={() => confirm(`Double or nothing on ${gts(b.allInStake)}?`) && post('/all-in')}>
            <Icon name="flame" size={20} />Go all-in
          </button>
        </div>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}
