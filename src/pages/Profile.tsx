import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import type { OwnEmailAddress } from '../../shared/types';
import VerifyEmailBanner from '../components/VerifyEmailBanner';
import { useAction, useMe } from '../hooks';

/** Crops to a centred square and downsizes so the avatar stays a few KB. */
async function toAvatarDataUrl(file: File, size = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export default function Profile() {
  const { me, reload } = useMe();
  const [name, setName] = useState(me.profileName);
  // Follow the account's name when it changes underneath us (after a merge, for instance)
  useEffect(() => {
    setName(me.profileName);
  }, [me.profileName]);
  const file = useRef<HTMLInputElement>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const merged = useSearchParams()[0].get('merged');
  const rm = useAction();

  const makePrimary = (e: OwnEmailAddress) => {
    const note = me.profileName ? '' : ' Until you set a display name, your friends will see this address instead of the old one.';
    if (!window.confirm(`Make ${e.email} your primary address?${note}`)) return;
    rm.run(async () => {
      await api(`/me/emails/${encodeURIComponent(e.email)}/primary`, 'POST');
      reload();
    });
  };

  const removeEmail = (e: OwnEmailAddress) => {
    const lines = [`Remove ${e.email} from your account?`];
    if (e.signsInWithPassword) lines.push('You will no longer be able to sign in with this address and your password.');
    if (e.primary) lines.push('Another verified address becomes your primary one.');
    if (!window.confirm(lines.join('\n\n'))) return;
    rm.run(async () => {
      await api(`/me/emails/${encodeURIComponent(e.email)}`, 'DELETE');
      reload();
    });
  };

  return (
    <>
      <header className="header"><h1>Profile</h1></header>
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
            const f = e.target.files?.[0];
            if (!f) return;
            act.run(async () => {
              await api('/me/avatar', 'PUT', { dataUrl: await toAvatarDataUrl(f) });
              reload();
            });
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
      {me.emails.length > 0 && (
        <section className="stack">
          <h2>Email addresses</h2>
          {me.emails.map((e) => (
            <div className="stack" key={e.email}>
              <div className="row row-wrap">
                <span className="grow">
                  <strong>{e.email}</strong> <span className="muted small">{e.verified ? '(verified ✓)' : '(not verified)'}</span>
                </span>
                {e.primary && <span className="pill">Primary</span>}
              </div>
              {e.signsInWithPassword && <small className="muted">You can sign in with this address and your password.</small>}
              <div className="row row-wrap">
                {!e.primary && e.verified && (
                  <button className="btn btn-small btn-secondary" disabled={rm.busy} onClick={() => makePrimary(e)}>
                    Make primary
                  </button>
                )}
                <button className="btn btn-small btn-secondary" disabled={rm.busy || !!e.removeBlocked} onClick={() => removeEmail(e)}>
                  Remove
                </button>
              </div>
              {e.removeBlocked && <small className="muted">{e.removeBlocked}</small>}
            </div>
          ))}
          {rm.error && <p className="error"><Icon name="alert" size={20} />{rm.error}</p>}
        </section>
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
    </>
  );
}
