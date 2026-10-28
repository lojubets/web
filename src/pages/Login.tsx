import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AppConfig } from '../../shared/types';
import { api, safeNext } from '../api';
import Rule from '../components/Rule';
import { useAction, useFetch } from '../hooks';

const LABELS = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' } as const;

export default function Login() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const { data: config } = useFetch<AppConfig>('/config');
  const { busy, error, run } = useAction();
  const pw = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    <>
      <section className="hero">
        <img className="hero-glass" src="/glass-256.png" width="112" height="112" alt="" />
        <h1>LoJuBets</h1>
        <p>Settle it with a friend. Closest guess wins a Gin & Tonic.</p>
      </section>
      <Rule />
      <main className="page auth-page">
        {params.get('error') && <p className="error">{params.get('error')}</p>}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            pw.run(async () => {
              await api(mode === 'login' ? '/auth/login' : '/auth/register', 'POST', { email, password });
              location.href = next;
            });
          }}
        >
          <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
          <input type="email" aria-label="Email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input
            type="password"
            aria-label="Password"
            placeholder={mode === 'register' ? 'Password (min 8 characters)' : 'Password'}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="btn" disabled={pw.busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
          {pw.error && <p className="error">{pw.error}</p>}
          {mode === 'login' && <Link className="link" to="/forgot-password">Forgot your password?</Link>}
          <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>

        {config && config.providers.length > 0 && (
          <section className="stack">
            <p className="eyebrow center">Or continue with</p>
            {config.providers.map((p) => (
              <a key={p} className="btn btn-secondary" href={`/api/auth/${p}?next=${encodeURIComponent(next)}`}>
                {LABELS[p]}
              </a>
            ))}
          </section>
        )}

        <p className="muted small center">
          By signing up you agree to how we handle your data, described in our <Link to="/privacy">privacy policy</Link>.
        </p>

        {config?.devLogin && (
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api('/auth/dev', 'POST', { name, email });
                location.href = next;
              });
            }}
          >
            <p className="eyebrow">Development only</p>
            <input aria-label="Name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <input type="email" aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="btn btn-secondary" disabled={busy}>Dev login</button>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </main>
    </>
  );
}
