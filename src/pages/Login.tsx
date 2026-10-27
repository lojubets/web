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
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

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
