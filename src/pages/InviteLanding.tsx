import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Friend } from '../../shared/types';
import { api } from '../api';
import { putRelations, type Invitations } from '../store';
import Rule from '../components/Rule';
import { useAction, useFetch } from '../hooks';

export default function InviteLanding({ signedIn, locked }: { signedIn: boolean; locked: boolean }) {
  const { token } = useParams();
  const nav = useNavigate();
  const { data, error } = useFetch<{ inviterName: string }>(`/invitations/token/${token}`);
  const act = useAction();

  return (
    <>
      <section className="hero">
        <img className="hero-glass" src="/glass-256.png" width="112" height="112" alt="" />
        {error ? (
          <>
            <h1>Invitation not found</h1>
            <p>{error}</p>
            <Link className="btn" to="/">Go to LoJuBets</Link>
          </>
        ) : data ? (
          <>
            <h1>{data.inviterName} wants to bet you a Gin & Tonic</h1>
            {locked ? (
              <>
                <p>Verify your email address first, then open this link again to accept.</p>
                <Link className="btn" to="/profile">Verify my email</Link>
              </>
            ) : signedIn ? (
              <>
                <p>Accept to become friends on LoJuBets and start betting.</p>
                <button
                  className="btn"
                  disabled={act.busy}
                  aria-busy={act.busy}
                  onClick={() => act.run(async () => {
                    // The answer includes the new friends list, so the friend's page has them at once
                    const r = await api<{ friendId: string; friends: Friend[]; invitations: Invitations }>(`/invitations/token/${token}/accept`, 'POST');
                    putRelations(r);
                    nav(`/friends/${r.friendId}`);
                  })}
                >
                  Accept invitation
                </button>
              </>
            ) : (
              <>
                <p>Accept to become friends on LoJuBets and start betting.</p>
                <Link className="btn" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in to accept</Link>
              </>
            )}
          </>
        ) : null}
      </section>
      <Rule />
      {act.error && <main className="page"><p className="error">{act.error}</p></main>}
    </>
  );
}
