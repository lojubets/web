import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import Avatar from '../components/Avatar';
import AvatarCropper from '../components/AvatarCropper';
import Icon from '../components/Icon';
import type { AppConfig, OwnEmailAddress, OwnLogin } from '../../shared/types';
import DeleteAccount from '../components/DeleteAccount';
import VerifyEmailBanner from '../components/VerifyEmailBanner';
import { useAction, useFetch, useMe } from '../hooks';

const PROVIDER_NAMES = { google: 'Google', microsoft: 'Microsoft', apple: 'Apple' } as const;

export default function Profile() {
  const { me, reload } = useMe();
  const [name, setName] = useState(me.profileName);
  // Follow the account's name when it changes underneath us (after a merge, for instance)
  useEffect(() => {
    setName(me.profileName);
  }, [me.profileName]);
  const file = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const query = useSearchParams()[0];
  const merged = query.get('merged');
  const connected = query.get('connected');
  const connectError = query.get('error');
  const { data: config } = useFetch<AppConfig>('/config');
  const connect = useAction();
  const [connectPw, setConnectPw] = useState('');
  const connectProvider = (provider: string) =>
    connect.run(async () => {
      await api('/me/connect', 'POST', { password: connectPw });
      location.href = `/api/auth/${provider}?connect=1`; // a full page load: the provider's sign-in follows
    });
  const rm = useAction();

  const makePrimary = (e: OwnEmailAddress) => {
    const note = me.profileName ? '' : ' Until you set a display name, your friends will see this address instead of the old one.';
    if (!window.confirm(`Make ${e.email} your primary address?${note}`)) return;
    rm.run(async () => {
      await api(`/me/emails/${encodeURIComponent(e.email)}/primary`, 'POST');
      reload();
    });
  };

  const [newEmail, setNewEmail] = useState('');
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const addMail = useAction();
  const note = (r: { result: string }, email: string) =>
    setEmailNote(
      {
        sent: `We sent a confirmation link to ${email}. Open it, and the address is yours to use.`,
        throttled: 'Please wait a minute before requesting another email.',
        not_configured: "This server can't send email yet, so verification isn't available.",
        failed: "We couldn't send the email. Try again later.",
      }[r.result] ?? 'Done.',
    );
  const addEmail = (ev: React.FormEvent) => {
    ev.preventDefault();
    const email = newEmail.trim();
    addMail.run(async () => {
      note(await api<{ result: string }>('/me/emails', 'POST', { email }), email.toLowerCase());
      setNewEmail('');
      reload();
    });
  };
  const resend = (e: OwnEmailAddress) =>
    addMail.run(async () => {
      try {
        note(await api<{ result: string }>(`/me/emails/${encodeURIComponent(e.email)}/verify`, 'POST'), e.email);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) note({ result: 'throttled' }, e.email);
        else throw err;
      }
    });

  const removeEmail = (e: OwnEmailAddress) => {
    const lines = [`Remove ${e.email} from your account?`];
    if (e.movesPasswordTo) lines.push(`You will sign in with ${e.movesPasswordTo} and your password from now on.`);
    else if (e.signsInWithPassword) lines.push('You will no longer be able to sign in with this address and your password.');
    if (e.primary) lines.push('Another verified address becomes your primary one.');
    if (!window.confirm(lines.join('\n\n'))) return;
    rm.run(async () => {
      await api(`/me/emails/${encodeURIComponent(e.email)}`, 'DELETE');
      reload();
    });
  };

  const removeLogin = (l: OwnLogin) => {
    const what = l.email ? `the email and password login for ${l.email}` : `your ${l.label} login${l.account ? ` (${l.account})` : ''}`;
    if (!window.confirm(`Remove ${what}?\n\nYou will no longer be able to sign in this way. Your email addresses stay on your account.`)) return;
    rm.run(async () => {
      await api(`/me/logins/${encodeURIComponent(l.provider)}/${encodeURIComponent(l.subject)}`, 'DELETE');
      reload();
    });
  };

  const passwordLogins = me.logins.filter((l) => l.provider === 'password');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwChanged, setPwChanged] = useState(false);
  const pw = useAction();
  const changePassword = (e: React.FormEvent) => {
    e.preventDefault();
    pw.run(async () => {
      await api('/me/password', 'POST', { currentPassword: currentPw, newPassword: newPw });
      setCurrentPw('');
      setNewPw('');
      setPwChanged(true);
      setTimeout(() => setPwChanged(false), 4000);
    });
  };

  return (
    <>
      <header className="header"><h1>Profile</h1></header>
      {connected && (
        <div className="banner banner-win">
          <Icon name="check" size={22} />
          <span>Sign-in connected. You can use it to sign in to this account from now on.</span>
        </div>
      )}
      {connectError && <p className="error"><Icon name="alert" size={20} />{connectError}</p>}
      {merged && (
        <div className="banner banner-win">
          <Icon name="check" size={22} />
          <span>Accounts merged. You can sign in with either account's login from now on.</span>
        </div>
      )}
      {me.email && !me.emailVerified && (
        <div className="card accent stack">
          <h2>Welcome to LoJuBets!</h2>
          <span>
            Once you've verified your email address, you can connect with friends and wage bets. Until then, this profile page is all there is.
            You can set your display name and picture in the meantime.
          </span>
        </div>
      )}
      <VerifyEmailBanner />
      {picked && (
        <AvatarCropper
          file={picked}
          busy={act.busy}
          onCancel={() => setPicked(null)}
          onSave={(dataUrl) =>
            act.run(async () => {
              await api('/me/avatar', 'PUT', { dataUrl });
              setPicked(null);
              reload();
            })
          }
        />
      )}
      <div className="profile-head">
        <button className="avatar-btn" onClick={() => file.current?.click()} aria-label="Change profile picture">
          <Avatar user={me} size={96} />
          <span className="edit-badge"><Icon name="pencil" size={18} /></span>
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            setPicked(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
        {me.hasAvatar && (
          <button className="link" onClick={() => act.run(async () => { await api('/me/avatar', 'DELETE'); reload(); })}>Remove picture</button>
        )}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            await api('/me', 'PUT', { name });
            reload();
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
          });
        }}
      >
        <label className="field">
          <span>Display name (optional)</span>
          <input value={name} maxLength={60} placeholder={me.email ?? 'Your name'} onChange={(e) => setName(e.target.value)} />
          {!me.profileName && <small className="muted">Until you set one, your friends see {me.email ? 'your email address' : 'you as "Friend"'}.</small>}
        </label>
        <button className="btn" disabled={act.busy || name.trim() === me.profileName}>{saved ? <><Icon name="check" size={18} />Saved</> : 'Save'}</button>
        {act.error && <p className="error">{act.error}</p>}
      </form>
      <section className="stack">
          <h2>Email addresses</h2>
          {me.emails.map((e) => (
            <div className="stack" key={e.email}>
              <div className="item">
                <div className="item-main">
                  <strong className="item-title">{e.email}</strong>
                  <div className="item-tags">
                    {e.primary && <span className="pill pill-cherry">Primary</span>}
                    {e.verified ? <span className="pill pill-positive"><Icon name="check" size={14} />Verified</span> : <span className="pill">Not verified</span>}
                  </div>
                </div>
                <button className="btn btn-icon btn-secondary" aria-label={`Remove ${e.email}`} title="Remove" disabled={rm.busy || !!e.removeBlocked} onClick={() => removeEmail(e)}>
                  <Icon name="trash" size={22} />
                </button>
              </div>
              {e.signsInWithPassword && <small className="muted">You can sign in with this address and your password.</small>}
              {(!e.verified || (!e.primary && e.verified)) && (
                <div className="row row-wrap">
                  {!e.verified && (
                    <button className="btn btn-small btn-secondary" disabled={addMail.busy} onClick={() => resend(e)}>
                      Send verification email
                    </button>
                  )}
                  {!e.primary && e.verified && (
                    <button className="btn btn-small btn-secondary" disabled={rm.busy} onClick={() => makePrimary(e)}>
                      Make primary
                    </button>
                  )}
                </div>
              )}
              {e.removeBlocked && <small className="muted">{e.removeBlocked}</small>}
            </div>
          ))}
          {rm.error && <p className="error"><Icon name="alert" size={20} />{rm.error}</p>}
          <form className="stack" onSubmit={addEmail}>
            <label className="field">
              <span>Add an email address</span>
              <input type="email" autoComplete="email" required value={newEmail} placeholder="you@example.com" onChange={(e) => setNewEmail(e.target.value)} />
              <small className="muted">We'll email a link to confirm it. Once it's confirmed you can make it your primary address and remove the old one.</small>
            </label>
            <button className="btn btn-secondary" disabled={addMail.busy || !newEmail.trim()}>Add address</button>
            {emailNote && <small>{emailNote}</small>}
            {addMail.error && <p className="error"><Icon name="alert" size={20} />{addMail.error}</p>}
          </form>
      </section>
      {me.logins.length > 0 && (
        <section className="stack">
          <h2>Ways to sign in</h2>
          {me.logins.map((l) => (
            <div className="stack" key={`${l.provider}:${l.subject}`}>
              <div className="item">
                <div className="item-main">
                  <strong className="item-title">{l.label}</strong>
                  {(l.email ?? l.account) && <span className="muted small">{l.email ?? l.account}</span>}
                </div>
                <button className="btn btn-icon btn-secondary" aria-label={`Remove ${l.label}`} title="Remove" disabled={rm.busy || !!l.removeBlocked} onClick={() => removeLogin(l)}>
                  <Icon name="trash" size={22} />
                </button>
              </div>
              {l.provider !== 'password' && l.provider !== 'dev' && !l.account && <small className="muted">Sign in with it once more to see which account it is.</small>}
              {l.removeBlocked && <small className="muted">{l.removeBlocked}</small>}
            </div>
          ))}
        </section>
      )}
      {config && config.providers.length > 0 && (
        <section className="stack">
          <h2>Connect another sign-in</h2>
          <small className="muted">
            Add a Google, Microsoft or Apple account as another way to sign in to this account, for example one that uses the same email
            address as an account you already have.
          </small>
          {passwordLogins.length > 0 && (
            <label className="field">
              <span>Your password</span>
              <input type="password" autoComplete="current-password" value={connectPw} onChange={(e) => setConnectPw(e.target.value)} />
            </label>
          )}
          <div className="row row-wrap">
            {config.providers.map((p) => (
              <button key={p} className="btn btn-small btn-secondary" disabled={connect.busy || (passwordLogins.length > 0 && !connectPw)} onClick={() => connectProvider(p)}>
                {PROVIDER_NAMES[p]}
              </button>
            ))}
          </div>
          {connect.error && <p className="error"><Icon name="alert" size={20} />{connect.error}</p>}
        </section>
      )}
      {passwordLogins.length > 0 && (
        <form className="card stack" onSubmit={changePassword}>
          <h2>Change password</h2>
          <label className="field">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" required value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" required minLength={8} maxLength={200} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            <small className="muted">At least 8 characters. Your other devices will be signed out.</small>
          </label>
          <button className="btn" disabled={pw.busy || !currentPw || newPw.length < 8}>
            {pwChanged ? <><Icon name="check" size={18} />Password changed</> : 'Change password'}
          </button>
          {pw.error && <p className="error"><Icon name="alert" size={20} />{pw.error}</p>}
        </form>
      )}
      {me.emailVerified && (
        <section className="card stack">
          <h2>Merge accounts</h2>
          <p className="muted small">
            Signed up twice, with different logins or emails? Merge the other account into this one: your friends, bets and sign-in
            methods all end up here, and you choose which email, name and photo to keep.
          </p>
          <Link className="btn btn-secondary" to="/merge">Merge accounts</Link>
        </section>
      )}
      <button
        className="btn btn-secondary"
        onClick={async () => {
          await api('/auth/logout', 'POST');
          location.href = '/login';
        }}
      >
        Sign out
      </button>
      <button
        className="btn btn-secondary"
        onClick={async () => {
          if (!confirm('Sign out on every device, including this one?')) return;
          await api('/auth/logout-everywhere', 'POST');
          await api('/auth/logout', 'POST');
          location.href = '/login';
        }}
      >
        Sign out everywhere
      </button>
      {me.emailVerified && <DeleteAccount />}
      <p className="muted small center"><Link to="/privacy">Privacy policy</Link></p>
    </>
  );
}
