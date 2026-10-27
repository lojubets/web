import { useRef, useState } from 'react';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
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
  const file = useRef<HTMLInputElement>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);

  return (
    <>
      <header className="header"><h1>Profile</h1></header>
      {me.email && !me.emailVerified && (
        <div className="card accent stack">
          <h2>Welcome to Lojubets!</h2>
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
        {me.email && <p className="muted small">Signed in as {me.email}{me.emailVerified ? ' (verified ✓)' : ' (not verified)'}</p>}
        <button className="btn" disabled={act.busy || name.trim() === me.profileName}>{saved ? <><Icon name="check" size={18} />Saved</> : 'Save'}</button>
        {act.error && <p className="error">{act.error}</p>}
      </form>
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
