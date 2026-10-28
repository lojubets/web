import { useState } from 'react';
import type { DeletionStatus } from '../../shared/types';
import { api } from '../api';
import { useAction, useFetch, useMe } from '../hooks';
import Icon from './Icon';

const day = (ms: number) => new Date(ms).toLocaleDateString();
const RESPONSES = { pending: 'Waiting for an answer', accepted: 'Accepted', refused: 'Refused', lapsed: 'No answer: cancelled' } as const;

/** Profile page: the danger zone. Deleting waits for ongoing bets, which friends are asked to cancel. */
export default function DeleteAccount() {
  const { me, reload: reloadMe } = useMe();
  const status = useFetch<DeletionStatus>('/me/deletion');
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const act = useAction();
  const help = useAction();
  const d = status.data;
  if (!d) return null;
  const hasPassword = me.emails.some((e) => e.signsInWithPassword);

  const start = () =>
    act.run(async () => {
      const r = await api<{ deleted: boolean }>('/me/deletion', 'POST', { confirm, password: hasPassword ? password : undefined });
      if (r.deleted) {
        location.href = '/login';
        return;
      }
      setOpen(false);
      setConfirm('');
      setPassword('');
      reloadMe();
      status.reload();
    });

  const withdraw = () =>
    act.run(async () => {
      await api('/me/deletion', 'DELETE');
      reloadMe();
      status.reload();
    });

  if (d.requestedAt) {
    return (
      <section className="card stack">
        <h2>Your account will be deleted</h2>
        <p className="small">
          It is deleted as soon as the bets below are done. Your friends were asked to cancel them; a bet nobody answers within {d.lapseDays} days
          (by {day(d.requestedAt + d.lapseDays * 86_400_000)}) is cancelled. You can't start new bets or send invitations meanwhile.
        </p>
        {d.ongoing.map((o) => (
          <div className="row row-wrap" key={o.betId}>
            <span className="grow"><strong>{o.question}</strong> <span className="muted small">with {o.other.name}</span></span>
            <span className="pill">{o.request ? RESPONSES[o.request.response] : 'Settle it to finish'}</span>
          </div>
        ))}
        <p className="muted small">A friend who refuses keeps the bet going: settle it together, or ask again after you withdraw and restart the deletion.</p>
        <button className="btn btn-secondary" disabled={act.busy} onClick={withdraw}>Keep my account</button>
        {sent ? (
          <p className="small">Message sent. We'll reply by email.</p>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              help.run(async () => {
                await api('/me/contact', 'POST', { message });
                setSent(true);
              });
            }}
          >
            <label className="field">
              <span>Stuck? Tell us</span>
              <textarea value={message} rows={3} maxLength={2000} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button className="btn btn-secondary" disabled={help.busy || message.trim().length < 5}>Send</button>
            {help.error && <p className="error">{help.error}</p>}
          </form>
        )}
        {act.error && <p className="error">{act.error}</p>}
      </section>
    );
  }

  if (!open) {
    return (
      <section className="stack">
        <h2>Delete account</h2>
        <p className="muted small">Erases your email, name, photo and logins. Bets you settled stay in your friends' history as "Deleted user".</p>
        <button className="btn btn-danger" onClick={() => setOpen(true)}>Delete my account</button>
      </section>
    );
  }

  return (
    <section className="card stack">
      <h2>Delete my account</h2>
      <ul className="small">
        <li>Your email addresses, name, photo, sign-in methods and invitations are erased for good. This can't be undone.</li>
        <li>Settled bets stay in your friends' history. They show "Deleted user", and your guess is removed. The question stays.</li>
        <li>Bets nobody has answered yet are cancelled.</li>
        {d.ongoing.length > 0 && (
          <li>
            You have {d.ongoing.length} ongoing bet{d.ongoing.length === 1 ? '' : 's'}. Your friends are asked to cancel {d.ongoing.length === 1 ? 'it' : 'them'}, and
            your account is deleted once they are done. If someone doesn't answer within {d.lapseDays} days, the bet is cancelled and the deletion goes ahead.
            If someone refuses, the bet stays until you settle it.
          </li>
        )}
      </ul>
      <a className="link" href="/api/me/export" download>Download my data first</a>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        {hasPassword && (
          <label className="field">
            <span>Your password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Type DELETE to confirm</span>
          <input value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button className="btn btn-danger" disabled={act.busy || confirm !== 'DELETE' || (hasPassword && !password)}>Delete my account</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        {act.error && <p className="error">{act.error}</p>}
      </form>
    </section>
  );
}
