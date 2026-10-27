import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Friend, Invitation } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import VerifyEmailBanner from '../components/VerifyEmailBanner';
import { balanceText } from '../format';
import { useAction, useFetch, useMe } from '../hooks';

export default function Friends() {
  const { me } = useMe();
  const canInvite = me.emailVerified;
  const friends = useFetch<Friend[]>('/friends');
  const invites = useFetch<{ sent: Invitation[]; received: Invitation[] }>('/invitations');
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ link: string; emailSent: boolean; email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useAction();
  const act = useAction();

  const refresh = () => Promise.all([friends.reload(), invites.reload()]);

  const share = async (link: string, to?: string) => {
    const text = `Let's bet a beer on Lojubets: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ text, url: link }); return; } catch { return; }
    }
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <header className="header"><h1>Friends</h1></header>
      <VerifyEmailBanner />

      {invites.data?.received.length ? (
        <section>
          <h2>Invitations for you</h2>
          <div className="stack">
            {invites.data.received.map((i) => (
              <div key={i.id} className="card row">
                <Avatar user={i.inviter} />
                <div className="grow"><strong>{i.inviter.name}</strong><div className="muted small">wants to connect</div></div>
                <button className="btn btn-small" disabled={act.busy} onClick={() => act.run(async () => { await api(`/invitations/${i.id}/accept`, 'POST'); await refresh(); })}>Accept</button>
                <button className="btn btn-small btn-secondary" disabled={act.busy} onClick={() => act.run(async () => { await api(`/invitations/${i.id}/decline`, 'POST'); await refresh(); })}>Decline</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="stack">
          {friends.data?.map((f) => (
            <Link key={f.id} to={`/friends/${f.id}`} className={`card row ${f.needsMyAction ? 'needs-action' : ''}`}>
              <Avatar user={f} />
              <div className="grow">
                <strong>{f.name}</strong>
                <div className={`small ${f.balance > 0 ? 'good' : f.balance < 0 ? 'bad' : 'muted'}`}>{balanceText(f.name, f.balance)}</div>
              </div>
              {f.openBets > 0 && <span className="pill">{f.openBets} open</span>}
            </Link>
          ))}
          {friends.data?.length === 0 && <p className="muted center">No friends yet. Invite someone below.</p>}
        </div>
      </section>

      <section>
        <h2>Invite a friend</h2>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            invite.run(async () => {
              const r = await api<{ link: string; emailSent: boolean }>('/invitations', 'POST', { email });
              setResult({ ...r, email });
              setEmail('');
              await invites.reload();
            });
          }}
        >
          <input type="email" placeholder="friend@example.com" value={email} disabled={!canInvite} onChange={(e) => setEmail(e.target.value)} required />
          <button className="btn" disabled={invite.busy || !canInvite}>Send invitation</button>
          {!canInvite && <p className="muted small">Verify your email address (above) before inviting friends.</p>}
          {invite.error && <p className="error">{invite.error}</p>}
        </form>
        {result && (
          <div className="card stack">
            <span>{result.emailSent ? `Invitation emailed to ${result.email}.` : `Invitation created for ${result.email}. Send them this link:`}</span>
            <button className="btn btn-secondary" onClick={() => share(result.link)}>{copied ? 'Link copied ✓' : 'Share invite link'}</button>
          </div>
        )}
        {invites.data?.sent.length ? (
          <div className="stack pending">
            <h2>Pending</h2>
            {invites.data.sent.map((i) => (
              <div key={i.id} className="card row">
                <div className="grow"><strong>{i.email}</strong></div>
                <button className="btn btn-small btn-secondary" onClick={() => share(`${location.origin}/invite/${i.token}`)}>Share link</button>
                <button className="btn btn-small btn-secondary" onClick={() => act.run(async () => { await api(`/invitations/${i.id}`, 'DELETE'); await invites.reload(); })}>Revoke</button>
              </div>
            ))}
          </div>
        ) : null}
        {act.error && <p className="error">{act.error}</p>}
      </section>
    </>
  );
}
