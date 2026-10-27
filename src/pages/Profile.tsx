import { useRef, useState } from 'react';
import { api } from '../api';
import Avatar from '../components/Avatar';
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
  const [name, setName] = useState(me.name);
  const file = useRef<HTMLInputElement>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);

  return (
    <>
      <header className="header"><h1>Profile</h1></header>
      <VerifyEmailBanner />
      <div className="profile-head">
        <button className="avatar-btn" onClick={() => file.current?.click()} aria-label="Change profile picture">
          <Avatar user={me} size={96} />
          <span className="edit-badge">✎</span>
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
          <span>Display name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
        </label>
        {me.email && <p className="muted small">Signed in as {me.email}{me.emailVerified ? ' (verified ✓)' : ''}</p>}
        <button className="btn" disabled={act.busy || name.trim() === me.name}>{saved ? 'Saved ✓' : 'Save'}</button>
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
