import { Link, useParams } from 'react-router-dom';
import type { Bet, Friend } from '../../shared/types';
import Avatar from '../components/Avatar';
import BetCard from '../components/BetCard';
import { balanceText } from '../format';
import { useFetch } from '../hooks';

export default function FriendDetail() {
  const { id } = useParams();
  const friends = useFetch<Friend[]>('/friends');
  const bets = useFetch<Bet[]>(`/bets?with=${id}`);
  const friend = friends.data?.find((f) => f.id === id);
  if (friends.loading) return <p className="center muted">Loading…</p>;
  if (!friend) return <p className="error">Friend not found.</p>;

  return (
    <>
      <header className="header"><Link to="/friends" className="back">‹ Friends</Link></header>
      <div className="profile-head">
        <Avatar user={friend} size={72} />
        <h1>{friend.name}</h1>
        <p className={`balance ${friend.balance > 0 ? 'good' : friend.balance < 0 ? 'bad' : 'muted'}`}>{balanceText(friend.name, friend.balance)}</p>
        <Link className="btn" to={`/bets/new?with=${friend.id}`}>New bet with {friend.name}</Link>
      </div>
      <div className="stack">
        {bets.data?.map((b) => <BetCard key={b.id} bet={b} friend={friend} />)}
        {bets.data?.length === 0 && <p className="muted center">No bets yet.</p>}
      </div>
    </>
  );
}
