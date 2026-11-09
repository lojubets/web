import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Friend } from '../../shared/types';
import { api } from '../api';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import { balanceText, gts } from '../format';
import { useAction, useFriends, useInvitations, useMe } from '../hooks';
import { putRelations, type Invitations } from '../store';

export default function Friends() {
  const { me } = useMe();
  const canInvite = me.emailVerified;
  const friends = useFriends();
  const invites = useInvitations();
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ link: string; emailSent: boolean; email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useAction();
  const act = useAction();

  // Invitation changes answer with the friends and invitations as they are now: into the model, then carry on.
  // The pressed button shows a spinner until then.
  type Relations = { friends: Friend[]; invitations: Invitations };
  const change = (key: string, method: string, path: string) =>
    act.run(async () => putRelations(await api<Relations>(path, method)), key);

  const share = async (link: string, to?: string) => {
    const text = `Let's bet a Gin & Tonic on LoJuBets: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ text, url: link }); return; } catch { return; }
    }
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {friends.data?.length ? <Tally friends={friends.data} /> : null}

      <header className="header"><h1>Friends</h1></header>

      {invites.data?.received.length ? (
        <section>
          <h2>Invitations for you</h2>
          <div className="stack">
            {invites.data.received.map((i) => (
              <div key={i.id} className="card row row-wrap">
                <Avatar user={i.inviter} size={44} />
                <div className="row-text"><strong>{i.inviter.name}</strong><div className="muted small">wants to connect</div></div>
                <div className="row-actions">
                  <button className="btn btn-small" disabled={act.busy} aria-busy={act.busyOn(`accept:${i.id}`)} onClick={() => change(`accept:${i.id}`, 'POST', `/invitations/${i.id}/accept`)}>Accept</button>
                  <button className="btn btn-small btn-secondary" disabled={act.busy} aria-busy={act.busyOn(`decline:${i.id}`)} onClick={() => change(`decline:${i.id}`, 'POST', `/invitations/${i.id}/decline`)}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="stack">
          {friends.data?.map((f) => (
            <Link key={f.id} to={`/friends/${f.id}`} className={`card row ${f.needsMyAction ? 'needs-action' : ''}`}>
              <Avatar user={f} size={44} />
              <div className="grow">
                <strong>{f.name}</strong>
                <div className="small"><span className={f.balance > 0 ? 'owed' : f.balance < 0 ? 'owe' : 'muted'}>{balanceText(f.balance)}</span></div>
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
              const r = await api<{ link: string; emailSent: boolean } & Relations>('/invitations', 'POST', { email });
              putRelations(r);
              setResult({ link: r.link, emailSent: r.emailSent, email });
              setEmail('');
            });
          }}
        >
          <input type="email" placeholder="friend@example.com" value={email} disabled={!canInvite} onChange={(e) => setEmail(e.target.value)} required />
          <button className="btn" disabled={invite.busy || !canInvite} aria-busy={invite.busy}>Send invitation</button>
          {!canInvite && <p className="muted small">Your account has no email address, so you can't send invitations.</p>}
          {invite.error && <p className="error">{invite.error}</p>}
        </form>
        {result && (
          <div className="card stack">
            <span>{result.emailSent ? `Invitation emailed to ${result.email}.` : `Invitation created for ${result.email}. Send them this link:`}</span>
            <button className="btn btn-secondary" onClick={() => share(result.link)}>{copied ? <><Icon name="check" size={18} />Link copied</> : 'Share invite link'}</button>
          </div>
        )}
        {invites.data?.sent.length ? (
          <div className="stack pending">
            <h2>Pending invitations</h2>
            {invites.data.sent.map((i) => (
              <div key={i.id} className="card row row-wrap">
                <div className="row-text"><strong>{i.email}</strong></div>
                <div className="row-actions">
                  <button className="btn btn-small btn-secondary" onClick={() => share(`${location.origin}/invite/${i.token}`)}>Share link</button>
                  <button className="btn btn-small btn-secondary" disabled={act.busy} aria-busy={act.busyOn(`revoke:${i.id}`)} onClick={() => change(`revoke:${i.id}`, 'DELETE', `/invitations/${i.id}`)}>Revoke</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {act.error && <p className="error">{act.error}</p>}
      </section>
    </>
  );
}

/** Where you stand with all your friends together: the net total, with what you're owed and what you owe as its detail. */
function Tally({ friends }: { friends: Friend[] }) {
  const owe = friends.reduce((sum, f) => sum + Math.max(0, -f.balance), 0);
  const owed = friends.reduce((sum, f) => sum + Math.max(0, f.balance), 0);
  const net = owed - owe;
  return (
    <div className="card tally" role="group" aria-label="Your tally">
      <span className="eyebrow muted">Overall</span>
      <span className="tally-total">
        {net === 0 ? 'All even' : <span className={net > 0 ? 'owed' : 'owe'}>{net > 0 ? '+' : '−'}{gts(Math.abs(net))}</span>}
      </span>
      <span className="small muted">Owed to you <b>{gts(owed)}</b> · You owe <b>{gts(owe)}</b></span>
    </div>
  );
}
