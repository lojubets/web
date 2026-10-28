import { Link } from 'react-router-dom';
import type { Bet, Friend } from '../../shared/types';
import BetCard from '../components/BetCard';
import CancelRequests from '../components/CancelRequests';
import Icon from '../components/Icon';
import { useFetch } from '../hooks';

export default function Bets() {
  const bets = useFetch<Bet[]>('/bets');
  const friends = useFetch<Friend[]>('/friends');
  const byId = new Map(friends.data?.map((f) => [f.id, f]));
  const list = bets.data ?? [];
  const yourMove = list.filter((b) => b.needsMyAction);
  const headsUp = list.filter((b) => b.tippingSoon && !b.needsMyAction);
  const inPlay = list.filter((b) => b.status !== 'settled' && !b.needsMyAction && !b.tippingSoon);
  const settled = list.filter((b) => b.status === 'settled');

  const section = (title: string, items: Bet[]) =>
    items.length > 0 && (
      <section>
        <h2>{title}</h2>
        <div className="stack">
          {items.map((b) => (
            <BetCard key={b.id} bet={b} friend={byId.get(b.otherUserId)} />
          ))}
        </div>
      </section>
    );

  return (
    <>
      <header className="header">
        <h1>Bets</h1>
        {friends.data?.length ? <Link className="btn btn-small" to="/bets/new"><Icon name="plus" size={18} />New bet</Link> : null}
      </header>
      {bets.error && <p className="error">{bets.error}</p>}
      {!bets.loading && friends.data?.length === 0 && (
        <div className="card empty">
          <img className="empty-can" src="/can-256.png" width="80" height="80" alt="" />
          <p>Bets are between friends. Invite someone to get started.</p>
          <Link className="btn" to="/friends">Invite a friend</Link>
        </div>
      )}
      {!bets.loading && friends.data?.length ? list.length === 0 && <div className="empty"><img className="empty-can" src="/can-256.png" width="80" height="80" alt="" /><p>No bets yet. Start one!</p></div> : null}
      <CancelRequests onAnswered={bets.reload} />
      {section('Your move', yourMove)}
      {section('Tipping point approaching', headsUp)}
      {section('In play', inPlay)}
      {section('Settled', settled)}
    </>
  );
}
