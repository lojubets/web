import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AppConfig } from '../../shared/types';
import { api } from '../api';
import { useAction, useFetch } from '../hooks';

const LABELS = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' } as const;

export default function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const { data: config } = useFetch<AppConfig>('/config');
  const { busy, error, run } = useAction();
  const pw = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    <div className="page login">
      <div className="hero">
        <div className="hero-beer">🍺</div>
        <h1>Lojubets</h1>
        <p className="muted">Settle it with a friend. Closest guess wins a beer.</p>
      </div>
      {params.get('error') && <p className="error">{params.get('error')}</p>}
      <div className="stack">
        {config?.providers.map((p) => (
          <a key={p} className="btn btn-secondary" href={`/api/auth/${p}?next=${encodeURIComponent(next)}`}>
            Continue with {LABELS[p]}
          </a>
        ))}
        {config && config.providers.length === 0 && !config.devLogin && (
          <p className="muted center">No sign-in providers are configured yet.</p>
        )}
      </div>
      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          pw.run(async () => {
            await api(mode === 'login' ? '/auth/login' : '/auth/register', 'POST', { name, email, password });
            location.href = next;
          });
        }}
      >
        <strong>{mode === 'login' ? 'Sign in with email' : 'Create an account'}</strong>
        {mode === 'register' && <input placeholder="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
        <input type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          type="password"
          placeholder={mode === 'register' ? 'Password (min 8 characters)' : 'Password'}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button className="btn" disabled={pw.busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {pw.error && <p className="error">{pw.error}</p>}
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
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
          <strong>Dev login</strong>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <button className="btn" disabled={busy}>Sign in (development only)</button>
          {error && <p className="error">{error}</p>}
        </form>
      )}
    </div>
  );
}
