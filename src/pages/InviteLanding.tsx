import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAction, useFetch } from '../hooks';

export default function InviteLanding({ signedIn, locked }: { signedIn: boolean; locked: boolean }) {
  const { token } = useParams();
  const nav = useNavigate();
  const { data, error } = useFetch<{ inviterName: string }>(`/invitations/token/${token}`);
  const act = useAction();

  return (
    <div className="page login">
      <div className="hero">
        <img className="hero-can" src="/can-256.png" width="112" height="112" alt="" />
        {error ? (
          <>
            <h1>Invitation not found</h1>
            <p className="muted">{error}</p>
            <Link className="btn" to="/">Go to Lojubets</Link>
          </>
        ) : data ? (
          <>
            <h1>{data.inviterName} wants to bet you a lonkero</h1>
            <p className="muted">Accept to become friends on Lojubets and start betting.</p>
            {locked ? (
              <>
                <p className="muted">Verify your email address first, then open this link again to accept.</p>
                <Link className="btn" to="/profile">Verify my email</Link>
              </>
            ) : signedIn ? (
              <button
                className="btn"
                disabled={act.busy}
                onClick={() => act.run(async () => {
                  const { friendId } = await api<{ friendId: string }>(`/invitations/token/${token}/accept`, 'POST');
                  nav(`/friends/${friendId}`);
                })}
              >
                Accept invitation
              </button>
            ) : (
              <Link className="btn" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
                Sign in to accept
              </Link>
            )}
            {act.error && <p className="error">{act.error}</p>}
          </>
        ) : null}
      </div>
    </div>
  );
}
