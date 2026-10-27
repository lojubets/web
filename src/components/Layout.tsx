import { NavLink, Outlet } from 'react-router-dom';
import { useFetch } from '../hooks';
import type { Friend } from '../../shared/types';

export default function Layout() {
  const { data: friends } = useFetch<Friend[]>('/friends');
  const actions = friends?.reduce((n, f) => n + f.needsMyAction, 0) ?? 0;
  return (
    <>
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/" end>
          <span>🍺</span>Bets{actions > 0 && <b className="badge">{actions}</b>}
        </NavLink>
        <NavLink to="/friends">
          <span>👥</span>Friends
        </NavLink>
        <NavLink to="/profile">
          <span>🙂</span>Profile
        </NavLink>
      </nav>
    </>
  );
}
