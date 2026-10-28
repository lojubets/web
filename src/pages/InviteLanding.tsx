import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import Wave from '../components/Wave';
import { useAction, useFetch } from '../hooks';

export default function InviteLanding({ signedIn, locked }: { signedIn: boolean; locked: boolean }) {
  const { token } = useParams();
  const nav = useNavigate();
  const { data, error } = useFetch<{ inviterName: string }>(`/invitations/token/${token}`);
  const act = useAction();

  return (
    <>
      <section className="hero">
        <img className="hero-can" src="/can-256.png" width="112" height="112" alt="" />
        {error ? (
          <>
            <h1>Invitation not found</h1>
            <p>{error}</p>
            <Link className="btn" to="/">Go to LoJuBets</Link>
          </>
        ) : data ? (
          <>
            <h1>{data.inviterName} wants to bet you a lonkero</h1>
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
                  onClick={() => act.run(async () => {
                    const { friendId } = await api<{ friendId: string }>(`/invitations/token/${token}/accept`, 'POST');
                    nav(`/friends/${friendId}`);
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
      <Wave />
      {act.error && <main className="page"><p className="error">{act.error}</p></main>}
    </>
  );
}
