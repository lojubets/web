import { describe, expect, it } from 'vitest';
import { db, ensureSchema } from './db.js';
import { balances, loadBet, loadSettlementsFor, requiredAcceptors, serializeBet } from './bets.js';

/**
 * A database from before group bets: every bet is one row with two players. `ensureSchema` must move the players,
 * guesses and results into bet_participants and bet_settlements, rebuild the table, and leave the bets readable.
 */
describe('migrating two-player bets', () => {
  it('moves players, guesses and results over, and the bets read as before', async () => {
    // The legacy shape, as the first release created it (later columns were added by the old migration steps)
    await db.execute(`CREATE TABLE bets (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, opponent_id TEXT NOT NULL, question TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      creator_guess TEXT NOT NULL, opponent_guess TEXT, outcome TEXT, outcome_proposed_by TEXT, winner_id TEXT,
      all_in INTEGER NOT NULL DEFAULT 0, stake INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, settled_at INTEGER)`);
    await db.execute(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    const t = 1_700_000_000_000;
    const row = (id: string, status: string, over: Record<string, string | number | null> = {}) => {
      const r = { id, creator_id: 'ann', opponent_id: 'bob', question: `Q ${id}`, kind: 'number', status, creator_guess: '2', opponent_guess: '5', outcome: null, outcome_proposed_by: null, winner_id: null, all_in: 0, stake: 1, created_at: t, settled_at: null, ...over };
      const cols = Object.keys(r);
      return db.execute({ sql: `INSERT INTO bets (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, args: cols.map((c) => r[c as keyof typeof r]) });
    };
    await row('won', 'settled', { outcome: '3', outcome_proposed_by: 'ann', winner_id: 'ann', settled_at: t + 1 });
    await row('allin', 'settled', { outcome: '5', outcome_proposed_by: 'bob', winner_id: 'bob', all_in: 1, stake: 3, settled_at: t + 2 });
    await row('draw', 'settled', { outcome: '3.5', outcome_proposed_by: 'ann', settled_at: t + 3 });
    await row('waiting', 'awaiting_guess', { opponent_guess: null });
    await row('creator_later', 'awaiting_guess', { creator_guess: '', opponent_guess: '5' });
    await row('active', 'active');
    await row('proposed', 'awaiting_confirmation', { outcome: '4', outcome_proposed_by: 'bob' });
    await row('declined', 'cancelled', { opponent_guess: null });
    await db.execute(`INSERT INTO users (id, email, email_verified, name, created_at) VALUES ('ann', 'ann@example.com', 1, 'Ann', ${t}), ('bob', 'bob@example.com', 1, 'Bob', ${t})`);
    // A freeform bet from after verdicts were added
    await db.execute('ALTER TABLE bets ADD COLUMN params TEXT');
    await db.execute('ALTER TABLE bets ADD COLUMN proposed_verdict TEXT');
    await row('verdict', 'awaiting_confirmation', { kind: 'text', creator_guess: 'a', opponent_guess: 'b', outcome: 'b!', outcome_proposed_by: 'ann', proposed_verdict: 'opponent' });

    await ensureSchema();
    await ensureSchema(); // idempotent

    const cols = (await db.execute('PRAGMA table_info(bets)')).rows.map((r) => r.name);
    expect(cols).not.toContain('opponent_id');
    expect(cols).toEqual(expect.arrayContaining(['proposed_winners', 'settle_days', 'started_at', 'settled_by_deadline']));
    expect(Number((await db.execute('SELECT count(*) AS n FROM bets')).rows[0].n)).toBe(9);

    const participants = async (id: string) => (await db.execute({ sql: 'SELECT user_id, status, guess FROM bet_participants WHERE bet_id = ? ORDER BY user_id', args: [id] })).rows.map((r) => [r.user_id, r.status, r.guess]);
    expect(await participants('won')).toEqual([['ann', 'joined', '2'], ['bob', 'joined', '5']]);
    expect(await participants('waiting')).toEqual([['ann', 'joined', '2'], ['bob', 'invited', null]]);
    expect(await participants('creator_later')).toEqual([['ann', 'joined', null], ['bob', 'joined', '5']]);
    expect(await participants('declined')).toEqual([['ann', 'joined', '2'], ['bob', 'declined', null]]);

    // Settled results became settlements, so balances are unchanged: Ann +1 -3 = -2 against Bob, and -1 more from the
    // freeform bet settled below
    const settled = await loadSettlementsFor('ann');
    expect(settled).toEqual(expect.arrayContaining([{ payerId: 'bob', payeeId: 'ann', amount: 1 }, { payerId: 'ann', payeeId: 'bob', amount: 3 }, { payerId: 'ann', payeeId: 'bob', amount: 1 }]));
    expect(settled).toHaveLength(3); // the draw moved nothing
    expect(balances('ann', settled).get('bob')).toBe(-3);

    const viewer = { id: 'ann', users: new Map(), balances: balances('ann', settled), allBets: [] };
    const won = serializeBet((await loadBet('won'))!, viewer);
    expect(won).toMatchObject({ status: 'settled', settledBy: 'outcome', winnerIds: ['ann'], myNet: 1, otherUserId: 'bob', startedAt: t });
    expect(serializeBet((await loadBet('allin'))!, viewer)).toMatchObject({ allIn: true, stake: 3, myNet: -3 });
    expect(serializeBet((await loadBet('draw'))!, viewer)).toMatchObject({ winnerIds: [], myNet: 0 });
    expect(serializeBet((await loadBet('waiting'))!, viewer)).toMatchObject({ status: 'awaiting_guess', myGuess: '2', startedAt: null });
    expect(serializeBet((await loadBet('creator_later'))!, viewer)).toMatchObject({ status: 'awaiting_guess', myGuess: null, needsMyAction: true });

    // Pending proposals carry on: Bob proposed 4 (he wins by it), so Ann is the one to accept
    const proposed = (await loadBet('proposed'))!;
    expect(requiredAcceptors(proposed).map((p) => p.user_id)).toEqual(['ann']);
    expect(serializeBet(proposed, viewer)).toMatchObject({ status: 'awaiting_confirmation', proposalKind: 'outcome', winnerIds: ['bob'], iMustAccept: true, needsMyAction: true, settleDeadline: null });
    // ...and a freeform verdict became the list of winners it named. Ann proposed that Bob won, so nobody's acceptance
    // was needed any more: it settled during the migration
    const verdict = (await loadBet('verdict'))!;
    expect(verdict.bet.proposed_winners).toBe('["bob"]');
    expect(serializeBet(verdict, viewer)).toMatchObject({ status: 'settled', winnerIds: ['bob'], myNet: -1 });
  });
});
