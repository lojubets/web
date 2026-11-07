import { Link } from 'react-router-dom';
import type { Bet, Participant } from '../../shared/types';
import Avatar from './Avatar';
import Icon from './Icon';
import { formatValue, gts, listNames } from '../format';

const until = (ms: number) => {
  const h = Math.max(1, Math.round((ms - Date.now()) / 3_600_000));
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

/** The other people in the bet: everyone who's in, or still deciding. */
export const others = (b: Bet): Participant[] => b.participants.filter((p) => !p.isMe && (p.status === 'joined' || p.status === 'invited'));

/** Who still has to answer the pending proposal. */
const waitingOn = (b: Bet) => listNames(b.participants.filter((p) => p.mustAccept && !p.accepted).map((p) => p.name));

export function statusLabel(b: Bet): string {
  const them = listNames(others(b).map((p) => p.name));
  const mine = b.participants.find((p) => p.isMe);
  switch (b.status) {
    case 'awaiting_guess': {
      if (mine?.status === 'invited') return 'Your guess is needed';
      if (mine?.status === 'declined') return 'You declined';
      if (b.myGuess === null) return 'Your guess is needed';
      const pending = others(b).filter((p) => !p.guessIn);
      return pending.length ? `Waiting for ${listNames(pending.map((p) => p.name))} to guess` : 'Waiting to start';
    }
    case 'active':
      return b.tippingPassed ? 'Has it happened yet?' : 'In play';
    case 'awaiting_confirmation': {
      const by = b.participants.find((p) => p.id === b.outcomeProposedBy)?.name ?? 'Someone';
      if (b.proposalKind === 'tie') return b.iMustAccept && !b.iAccepted ? 'Agree to call it off?' : `Waiting for ${waitingOn(b)} to agree to a tie`;
      if (b.proposalKind === 'not_happened') return b.iMustAccept && !b.iAccepted ? "Confirm it hasn't happened" : `Waiting for ${waitingOn(b)} to agree it hasn't happened`;
      if (b.iMustAccept && !b.iAccepted) return `${by} proposed a result: confirm?`;
      return `Waiting for ${waitingOn(b)} to confirm`;
    }
    case 'settled': {
      if (mine?.status !== 'joined') return 'Started without you';
      if (b.settledBy === 'tie') return 'Called off by agreement';
      if (b.winnerIds.length === 0) return 'Draw, no GT';
      if (b.winnerIds.includes(mine.id)) return b.winnerIds.length === 1 ? 'You won' : `You won, with ${listNames(b.participants.filter((p) => p.winner && !p.isMe).map((p) => p.name))}`;
      return `${listNames(b.participants.filter((p) => p.winner).map((p) => p.name))} won`;
    }
    default:
      return (b.status as string) || them;
  }
}

export default function BetCard({ bet }: { bet: Bet }) {
  const them = others(bet);
  return (
    <Link to={`/bets/${bet.id}`} className={`card bet ${bet.needsMyAction ? 'needs-action' : ''}`}>
      {them.length === 1 ? (
        <Avatar user={them[0]} size={44} />
      ) : (
        <span className="avatar-stack" aria-hidden="true">
          {them.slice(0, 3).map((p) => (
            <Avatar key={p.id} user={p} size={28} />
          ))}
        </span>
      )}
      <div className="bet-main">
        <div className="bet-q">{bet.question}</div>
        <div className="muted small">
          {them.length === 1 ? 'vs' : 'with'} {listNames(them.map((p) => p.name))} · {statusLabel(bet)}
          {bet.status === 'settled' && bet.outcome !== null && ` · ${formatValue(bet.kind, bet.params, bet.outcome)}`}
          {bet.status === 'settled' && bet.settledBy === 'tipping_point' && ' · event had not happened'}
        </div>
        {(bet.needsMyAction || bet.tippingSoon || bet.allIn || bet.settleDeadline) && (
          <div className="tags">
            {bet.needsMyAction && <span className="pill pill-cherry">Your move</span>}
            {bet.tippingSoon && bet.tippingPoint && <span className="pill pill-dare"><Icon name="clock" size={14} />{until(bet.tippingPoint)}</span>}
            {bet.settleDeadline && <span className="pill"><Icon name="clock" size={14} />Settles in {until(bet.settleDeadline)}</span>}
            {bet.allIn && <span className="pill pill-dare"><Icon name="flame" size={14} />All-in {gts(bet.stake)}</span>}
          </div>
        )}
      </div>
    </Link>
  );
}
