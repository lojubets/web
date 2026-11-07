import { Link, useParams } from 'react-router-dom';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import BetSections from '../components/BetSections';
import { balanceText } from '../format';
import { useBetsWith, useFriends } from '../hooks';

export default function FriendDetail() {
  const { id } = useParams();
  const friends = useFriends();
  const bets = useBetsWith(id!);
  const friend = friends.data?.find((f) => f.id === id);
  if (friends.loading) return <p className="center muted">Loading…</p>;
  if (!friend) return <p className="error">Friend not found.</p>;

  return (
    <>
      <header className="header"><Link to="/friends" className="back"><Icon name="chevron-left" size={22} />Friends</Link></header>
      <div className="profile-head">
        <Avatar user={friend} size={72} />
        <h1>{friend.name}</h1>
        <p className="balance"><span className={friend.balance > 0 ? 'owed' : friend.balance < 0 ? 'owe' : 'muted'}>{balanceText(friend.balance)}</span></p>
        <Link className="btn" to={`/bets/new?with=${friend.id}`}>New bet with {friend.name}</Link>
      </div>
      {bets.error && <p className="error">{bets.error}</p>}
      {bets.data?.length === 0 && <p className="muted center">No bets yet.</p>}
      <BetSections bets={bets.data ?? []} />
    </>
  );
}
