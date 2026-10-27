import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { AppConfig, MergeChoices, MergePreview, MergeSide } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import { useAction, useFetch, useMe } from '../hooks';

const LABELS = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' } as const;

export default function Merge() {
  const preview = useFetch<MergePreview>('/merge/preview');
  const urlError = useSearchParams()[0].get('error');
  return (
    <>
      <header className="header">
        <Link to="/profile" className="back"><Icon name="chevron-left" size={22} />Profile</Link>
      </header>
      <h1>Merge accounts</h1>
      {preview.data ? (
        <Choose preview={preview.data} />
      ) : preview.loading ? (
        <p className="center muted">Loading…</p>
      ) : (
        <SignInToOther error={urlError} onSignedIn={preview.reload} />
      )}
    </>
  );
}

/** Step 1: prove you can sign in to the other account. You stay signed in as this one. */
function SignInToOther({ error: urlError, onSignedIn }: { error: string | null; onSignedIn: () => void }) {
  const { me } = useMe();
  const { data: config } = useFetch<AppConfig>('/config');
  const pw = useAction();
  const dev = useAction();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [devEmail, setDevEmail] = useState('');

  return (
    <>
      <p>
        You're signed in as <strong>{me.name}</strong> and you'll stay signed in as this account. Sign in to the <strong>other</strong> account to
        merge it into this one. You'll then choose which email address, display name and photo to keep.
      </p>
      <p className="muted small">Both accounts need a verified email address, and you'll be able to sign in with either account's login afterwards.</p>
      {urlError && <p className="error"><Icon name="alert" size={20} />{urlError}</p>}

      {config && config.providers.length > 0 && (
        <section className="stack">
          <p className="eyebrow">Sign in to the other account with</p>
          {config.providers.map((p) => (
            <a key={p} className="btn btn-secondary" href={`/api/auth/${p}?merge=1&next=${encodeURIComponent('/merge')}`}>{LABELS[p]}</a>
          ))}
        </section>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          pw.run(async () => {
            await api('/merge/password', 'POST', { email, password });
            onSignedIn();
          });
        }}
      >
        <p className="eyebrow">{config && config.providers.length > 0 ? 'Or with an email and password' : 'Sign in with an email and password'}</p>
        <input type="email" aria-label="Email of the other account" placeholder="Email of the other account" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" aria-label="Password of the other account" placeholder="Password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn" disabled={pw.busy}>Sign in to the other account</button>
        {pw.error && <p className="error"><Icon name="alert" size={20} />{pw.error}</p>}
      </form>

      {config?.devLogin && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            dev.run(async () => {
              await api('/merge/dev', 'POST', { email: devEmail });
              onSignedIn();
            });
          }}
        >
          <p className="eyebrow">Development only</p>
          <input type="email" aria-label="Dev account email" placeholder="Email of a dev account" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} required />
          <button className="btn btn-secondary" disabled={dev.busy}>Dev login to the other account</button>
          {dev.error && <p className="error"><Icon name="alert" size={20} />{dev.error}</p>}
        </form>
      )}
    </>
  );
}

const photoUrl = (side: 'a' | 'b', s: MergeSide) => `/api/merge/avatar/${side}?v=${s.avatarVersion}`;
const shownName = (s: MergeSide) => s.profileName || s.primaryEmail || 'Friend';

function SideCard({ title, side, s }: { title: string; side: 'a' | 'b'; s: MergeSide }) {
  return (
    <div className="card stack">
      <p className="eyebrow">{title}</p>
      <div className="row">
        <Avatar user={s} size={48} src={photoUrl(side, s)} />
        <div className="grow">
          <strong>{s.name}</strong>
          <div className="muted small">{s.friends} {s.friends === 1 ? 'friend' : 'friends'} · {s.bets} {s.bets === 1 ? 'bet' : 'bets'}</div>
        </div>
      </div>
      {s.emails.map((e) => (
        <div key={e.email} className="small">
          <strong>{e.email}</strong> <span className="muted">{e.verified ? '(verified ✓)' : '(not verified)'}</span>
        </div>
      ))}
    </div>
  );
}

function Choice<T extends string>({ label, hint, value, onChange, options, list }: {
  label: string;
  hint?: string;
  list?: boolean;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; content: React.ReactNode }[];
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className={`segmented ${list ? '' : 'two'}`} role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button type="button" key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
            {o.content}
          </button>
        ))}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Step 2: both profiles, and which email, name and photo the merged account keeps. */
function Choose({ preview }: { preview: MergePreview }) {
  const { a, b } = preview;
  const nav = useNavigate();
  const { reload } = useMe();
  const act = useAction();
  const anyPhoto = a.hasAvatar || b.hasAvatar;
  const [choices, setChoices] = useState<MergeChoices>({ email: 'a', name: 'a', photo: a.hasAvatar || !b.hasAvatar ? (a.hasAvatar ? 'a' : 'none') : 'b' });
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  const set = <K extends keyof MergeChoices>(k: K, v: MergeChoices[K]) => setChoices((c) => ({ ...c, [k]: v }));
  const blocked = preview.blockers.length > 0;

  return (
    <>
      <SideCard title="This account (stays signed in)" side="a" s={a} />
      <SideCard title="Other account (merged into this one)" side="b" s={b} />

      {preview.blockers.map((text) => (
        <div className="banner banner-owe" key={text}>
          <Icon name="alert" size={22} />
          <span>{text}</span>
        </div>
      ))}

      <Choice
        label="Email address to use"
        hint="The other address stays on your account too, with its verification status, and you can still sign in with either."
        value={choices.email}
        onChange={(v) => set('email', v)}
        options={[
          { value: 'a', content: <strong>{a.primaryEmail}</strong> },
          { value: 'b', content: <strong>{b.primaryEmail}</strong> },
        ]}
      />
      <Choice
        label="Display name"
        value={choices.name}
        onChange={(v) => set('name', v)}
        options={[
          { value: 'a', content: <><strong>{shownName(a)}</strong>{!a.profileName && <span className="small muted">no name set</span>}</> },
          { value: 'b', content: <><strong>{shownName(b)}</strong>{!b.profileName && <span className="small muted">no name set</span>}</> },
        ]}
      />
      {anyPhoto && (
        <Choice
          label="Profile photo"
          list
          value={choices.photo}
          onChange={(v) => set('photo', v)}
          options={[
            ...(a.hasAvatar ? [{ value: 'a' as const, content: <span className="row"><Avatar user={a} size={40} src={photoUrl('a', a)} /><strong>This account's photo</strong></span> }] : []),
            ...(b.hasAvatar ? [{ value: 'b' as const, content: <span className="row"><Avatar user={b} size={40} src={photoUrl('b', b)} /><strong>Other account's photo</strong></span> }] : []),
            { value: 'none' as const, content: <strong>No photo (show initials)</strong> },
          ]}
        />
      )}

      <div className="card accent stack">
        <h2>What happens</h2>
        <ul className="examples">
          <li>Friends and bets from both accounts are combined.</li>
          <li>You can sign in with either account's login (Google, Microsoft, Apple or email and password).</li>
          {preview.betsBetween > 0 && (
            <li>{preview.betsBetween} finished {preview.betsBetween === 1 ? 'bet' : 'bets'} between these two accounts will be removed.</li>
          )}
          <li>The other account is deleted. This can't be undone.</li>
        </ul>
      </div>

      {act.error && <p className="error"><Icon name="alert" size={20} />{act.error}</p>}
      <button
        className="btn"
        disabled={act.busy || blocked}
        onClick={() =>
          act.run(async () => {
            await api('/merge/confirm', 'POST', choices);
            reload();
            nav('/profile?merged=1');
          })
        }
      >
        Merge accounts
      </button>
      <button
        className="btn btn-secondary"
        disabled={act.busy}
        onClick={async () => {
          await api('/merge', 'DELETE');
          nav('/profile');
        }}
      >
        Cancel
      </button>
    </>
  );
}
