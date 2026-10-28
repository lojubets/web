import { NavLink, Outlet } from 'react-router-dom';
import type { Friend } from '../../shared/types';
import { useFetch } from '../hooks';
import Icon from './Icon';
import Rule from './Rule';

export default function Layout({ locked }: { locked: boolean }) {
  const { data: friends } = useFetch<Friend[]>(locked ? null : '/friends');
  const actions = friends?.reduce((n, f) => n + f.needsMyAction, 0) ?? 0;
  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <img src="/glass-64.png" alt="" />
          <span className="wordmark">LoJuBets</span>
        </div>
      </header>
      <Rule />
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {!locked && (
          <>
            <NavLink to="/" end>
              <span className="tab-icon"><Icon name="glass" size={24} /></span>
              Bets
              {actions > 0 && <b className="badge" aria-label={`${actions} waiting for you`}>{actions}</b>}
            </NavLink>
            <NavLink to="/friends">
              <span className="tab-icon"><Icon name="friends" size={24} /></span>
              Friends
            </NavLink>
          </>
        )}
        <NavLink to="/profile">
          <span className="tab-icon"><Icon name="user" size={24} /></span>
          Profile
        </NavLink>
      </nav>
    </>
  );
}
