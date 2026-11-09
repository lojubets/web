import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Me } from '../shared/types';
import { api, ApiError } from './api';
import { cachedMe, setOwner } from './store';
import Layout from './components/Layout';
import { MeContext } from './hooks';
import BetDetail from './pages/BetDetail';
import Bets from './pages/Bets';
import FriendDetail from './pages/FriendDetail';
import Friends from './pages/Friends';
import InviteLanding from './pages/InviteLanding';
import Login from './pages/Login';
import Merge from './pages/Merge';
import NewBet from './pages/NewBet';
import Privacy from './pages/Privacy';
import Profile from './pages/Profile';
import Styleguide from './pages/Styleguide';
import VerifyEmail from './pages/VerifyEmail';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';

export default function App() {
  // Start from the user as last seen on this device (so cached friends and bets show at once); /me confirms it
  const [me, setMe] = useState<Me | null | undefined>(() => cachedMe()); // undefined = loading
  const location = useLocation();
  // A new screen starts at the top, as on a native app.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // The signed-in user, from /me or as a change to the account returned it
  const takeMe = (m: Me) => {
    setOwner(m);
    setMe(m);
  };
  const load = () =>
    api<Me>('/me')
      .then(takeMe)
      .catch((e) => {
        // Signed out (401): forget the previous user's friends and bets. A network hiccup or a server error keeps them,
        // and whoever was signed in.
        if (e instanceof ApiError && e.status === 401) {
          setOwner(null);
          setMe(null);
        } else setMe((m) => m ?? null);
      });
  useEffect(() => {
    load();
    // Verifying happens in another tab; pick it up when the user comes back.
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (me === undefined) return <p className="center muted">Loading…</p>;

  // Until an unverified email is confirmed, the only place to be is the profile page.
  const locked = !!me && !me.emailVerified;

  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/styleguide" element={<Styleguide />} />
      <Route path="/invite/:token" element={<InviteLanding signedIn={!!me} locked={locked} />} />
      <Route
        element={
          me ? (
            locked && location.pathname !== '/profile' ? (
              <Navigate to="/profile" replace />
            ) : (
              <MeContext.Provider value={{ me, reload: load, setMe: takeMe }}>
                <Layout locked={locked} />
              </MeContext.Provider>
            )
          ) : (
            <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />
          )
        }
      >
        <Route index element={<Bets />} />
        <Route path="bets/new" element={<NewBet />} />
        <Route path="bets/:id" element={<BetDetail />} />
        <Route path="friends" element={<Friends />} />
        <Route path="friends/:id" element={<FriendDetail />} />
        <Route path="profile" element={<Profile />} />
        <Route path="merge" element={<Merge />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
