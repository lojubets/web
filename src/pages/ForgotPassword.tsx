import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Icon from '../components/Icon';
import Wave from '../components/Wave';
import { useAction } from '../hooks';

export default function ForgotPassword() {
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  return (
    <>
      <section className="hero">
        <span className="hero-icon"><Icon name="mail" size={36} /></span>
        <h1>Forgot your password?</h1>
        <p>{sent ? 'Check your inbox.' : "Enter the email you signed up with and we'll send you a link to choose a new one."}</p>
      </section>
      <Wave />
      <main className="page auth-page">
        {sent ? (
          // The same message whether or not the address has an account, so this page can't be used to look people up.
          <p>
            If a password account uses <strong>{email}</strong>, a link to reset the password is on its way. It works for one hour. If you
            signed up with Google, Microsoft or Apple, sign in with that instead.
          </p>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('/auth/forgot-password', 'POST', { email });
                setSent(true);
              });
            }}
          >
            <input type="email" aria-label="Email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="btn" disabled={busy}>Send reset link</button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
        <Link className="link center" to="/login">Back to sign in</Link>
      </main>
    </>
  );
}
