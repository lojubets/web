import { Link } from 'react-router-dom';
import type { CancelRequest } from '../../shared/types';
import { api } from '../api';
import { useAction, useFetch } from '../hooks';
import { dropBet, refresh } from '../store';
import Icon from './Icon';

/** Friends who are deleting their account ask to cancel a bet. No answer within the deadline cancels it. */
export default function CancelRequests() {
  const reqs = useFetch<CancelRequest[]>('/me/cancel-requests');
  const act = useAction();
  if (!reqs.data?.length) return null;

  const answer = (r: CancelRequest, what: 'accept' | 'refuse') =>
    act.run(async () => {
      await api(`/bets/${r.betId}/cancel-request/${what}`, 'POST', { from: r.from.id });
      // Answered: the request goes, and a cancelled bet leaves the list. A kept bet is refreshed behind the scenes.
      reqs.set(reqs.data!.filter((x) => x !== r));
      if (what === 'accept') dropBet(r.betId);
      else refresh(`bet:${r.betId}`, true);
    }, `${what}:${r.betId}`);

  return (
    <section>
      <h2>Cancel a bet?</h2>
      <div className="stack">
        {reqs.data.map((r) => (
          <div className="card needs-action stack" key={r.betId}>
            <strong className="row"><Icon name="alert" size={22} />{r.from.name} is deleting their account</strong>
            <span className="small">
              They ask to cancel <Link to={`/bets/${r.betId}`}>{r.question}</Link>. If you don't answer by {new Date(r.lapsesAt).toLocaleDateString()}, it is cancelled.
              If you refuse, the bet stays until you settle it.
            </span>
            <div className="row row-wrap">
              <button className="btn btn-small" disabled={act.busy} aria-busy={act.busyOn(`accept:${r.betId}`)} onClick={() => answer(r, 'accept')}>Cancel the bet</button>
              <button className="btn btn-small btn-secondary" disabled={act.busy} aria-busy={act.busyOn(`refuse:${r.betId}`)} onClick={() => answer(r, 'refuse')}>Keep the bet</button>
            </div>
          </div>
        ))}
        {act.error && <p className="error">{act.error}</p>}
      </div>
    </section>
  );
}
