import { Link } from 'react-router-dom';
import type { Bet, Friend } from '../../shared/types';
import Avatar from './Avatar';
import { beers, formatValue } from '../format';

const until = (ms: number) => {
  const h = Math.max(1, Math.round((ms - Date.now()) / 3_600_000));
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
};

export function statusLabel(b: Bet, name: string): string {
  switch (b.status) {
    case 'awaiting_guess':
      return b.iAmCreator ? `Waiting for ${name}'s guess` : 'Your guess is needed';
    case 'active':
      return b.tippingPassed ? 'Has it happened yet?' : 'In play';
    case 'awaiting_confirmation':
      if (b.proposalKind === 'not_happened') return b.outcomeProposedByMe ? `Waiting for ${name} to agree it hasn't happened` : "Confirm it hasn't happened";
      return b.outcomeProposedByMe ? `Waiting for ${name} to confirm` : 'Confirm the outcome';
    case 'settled':
      return b.winnerId === null ? 'Draw, no beer' : b.winnerId === b.otherUserId ? `${name} won` : 'You won';
    default:
      return b.status;
  }
}

export default function BetCard({ bet, friend }: { bet: Bet; friend?: Friend }) {
  const name = friend?.name ?? 'Friend';
  return (
    <Link to={`/bets/${bet.id}`} className={`card bet ${bet.needsMyAction ? 'needs-action' : ''}`}>
      {friend && <Avatar user={friend} size={36} />}
      <div className="bet-main">
        <div className="bet-q">{bet.question}</div>
        <div className="muted small">
          vs {name} · {statusLabel(bet, name)}
          {bet.status === 'settled' && bet.outcome !== null && ` · ${formatValue(bet.kind, bet.params, bet.outcome)}`}
          {bet.status === 'settled' && bet.settledBy === 'tipping_point' && ' · event had not happened'}
        </div>
      </div>
      {bet.tippingSoon && bet.tippingPoint && <span className="pill warn">⏰ {until(bet.tippingPoint)}</span>}
      {bet.allIn && <span className="pill">All-in {beers(bet.stake)}</span>}
    </Link>
  );
}
