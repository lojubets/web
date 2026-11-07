import type { Bet } from '../../shared/types';
import BetCard from './BetCard';

/** Splits a list of bets into the groups the Bets tab shows, in display order. Empty groups are left out. */
export function groupBets(list: Bet[]): { title: string; items: Bet[] }[] {
  return [
    { title: 'Your move', items: list.filter((b) => b.needsMyAction) },
    { title: 'Tipping point approaching', items: list.filter((b) => b.tippingSoon && !b.needsMyAction) },
    { title: 'In play', items: list.filter((b) => b.status !== 'settled' && !b.needsMyAction && !b.tippingSoon) },
    { title: 'Settled', items: list.filter((b) => b.status === 'settled') },
  ].filter((g) => g.items.length > 0);
}

/** Renders bets grouped under "Your move", "Tipping point approaching", "In play" and "Settled" headings. */
export default function BetSections({ bets }: { bets: Bet[] }) {
  return (
    <>
      {groupBets(bets).map((g) => (
        <section key={g.title}>
          <h2>{g.title}</h2>
          <div className="stack">
            {g.items.map((b) => (
              <BetCard key={b.id} bet={b} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
