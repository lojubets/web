import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import Icon from '../components/Icon';
import Wave from '../components/Wave';
import { useAction } from '../hooks';

export default function ResetPassword() {
  const token = useSearchParams()[0].get('token') ?? '';
  const { busy, error, run } = useAction();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  return (
    <>
      <section className="hero">
        <span className="hero-icon"><Icon name={done ? 'check' : 'mail'} size={36} /></span>
        <h1>{done ? 'Password changed' : 'Choose a new password'}</h1>
        <p>{done ? 'You were signed out everywhere. Sign in with your new password.' : 'At least 8 characters.'}</p>
      </section>
      <Wave />
      <main className="page auth-page">
        {done ? (
          <Link className="btn" to="/login">Sign in</Link>
        ) : (
          // Submitting is a POST, so mail scanners that prefetch the link can't use up the token.
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('/auth/reset-password', 'POST', { token, password });
                setDone(true);
              });
            }}
          >
            <input type="password" aria-label="New password" placeholder="New password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <button className="btn" disabled={busy || !token}>Change password</button>
            {error && <p className="error">{error}</p>}
            <Link className="link center" to="/forgot-password">Send me a new link</Link>
          </form>
        )}
      </main>
    </>
  );
}
