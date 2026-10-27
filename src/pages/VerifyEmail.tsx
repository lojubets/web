import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';

// Verification needs a click (a POST) so mail scanners that prefetch links can't use up the token.
export default function VerifyEmail() {
  const token = useSearchParams()[0].get('token') ?? '';
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);

  return (
    <div className="page login">
      <div className="hero">
        <div className="hero-emoji">{done ? '✅' : '✉️'}</div>
        {done ? (
          <>
            <h1>Email verified</h1>
            <a className="btn" href="/">Continue to Lojubets</a>
          </>
        ) : (
          <>
            <h1>Confirm your email</h1>
            <button className="btn" disabled={busy || !token} onClick={() => run(async () => { await api('/auth/verify-email', 'POST', { token }); setDone(true); })}>
              Confirm email address
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
