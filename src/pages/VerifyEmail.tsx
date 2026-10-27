import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import Icon from '../components/Icon';
import Wave from '../components/Wave';
import { useAction } from '../hooks';

// Verification needs a click (a POST) so mail scanners that prefetch links can't use up the token.
export default function VerifyEmail() {
  const token = useSearchParams()[0].get('token') ?? '';
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);

  return (
    <>
      <section className="hero">
        <span className="hero-icon"><Icon name={done ? 'check' : 'mail'} size={36} /></span>
        {done ? (
          <>
            <h1>Email verified</h1>
            <p>You can connect with friends and wage bets now.</p>
            {/* A full page load, so the app re-reads the (now verified) account instead of using the stale one. */}
            <a className="btn" href="/">Continue to Lojubets</a>
          </>
        ) : (
          <>
            <h1>Confirm your email</h1>
            <p>One tap and you're in.</p>
            <button className="btn" disabled={busy || !token} onClick={() => run(async () => { await api('/auth/verify-email', 'POST', { token }); setDone(true); })}>
              Confirm email address
            </button>
          </>
        )}
      </section>
      <Wave />
      {error && <main className="page"><p className="error">{error}</p></main>}
    </>
  );
}
