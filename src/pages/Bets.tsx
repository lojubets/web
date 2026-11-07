import { Link } from 'react-router-dom';
import BetSections from '../components/BetSections';
import CancelRequests from '../components/CancelRequests';
import Icon from '../components/Icon';
import { useFriends, useMyBets } from '../hooks';

export default function Bets() {
  const bets = useMyBets();
  const friends = useFriends();
  const list = bets.data ?? [];

  return (
    <>
      <header className="header">
        <h1>Bets</h1>
        {friends.data?.length ? <Link className="btn btn-small" to="/bets/new"><Icon name="plus" size={18} />New bet</Link> : null}
      </header>
      {bets.error && <p className="error">{bets.error}</p>}
      {!bets.loading && friends.data?.length === 0 && (
        <div className="card empty">
          <img className="empty-glass" src="/glass-256.png" width="80" height="80" alt="" />
          <p>Bets are between friends. Invite someone to get started.</p>
          <Link className="btn" to="/friends">Invite a friend</Link>
        </div>
      )}
      {!bets.loading && friends.data?.length ? list.length === 0 && <div className="empty"><img className="empty-glass" src="/glass-256.png" width="80" height="80" alt="" /><p>No bets yet. Start one!</p></div> : null}
      <CancelRequests onAnswered={bets.reload} />
      <BetSections bets={list} />
    </>
  );
}
