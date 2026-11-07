import type { Bet, BetKind, BetStatus, Participant, UserSummary } from '../shared/types.js';
import { latestGuessers, loadParams, tippingPoint, transfers, winners, type Guesser, type Transfer } from './betLogic.js';
import { db } from './db.js';

/**
 * The bet engine: a bet has two or more players, and "winners collect" when it settles: every player who didn't
 * win owes each winner the stake. A proposed result settles once everyone except the proposer and a sole winner has
 * accepted it (see `requiredAcceptors` for why that is enough). A bet can carry a deadline after which silence
 * counts as acceptance, so one absent player can't hold it up forever.
 */

export type ProposalKind = 'outcome' | 'not_happened' | 'tie';
export type ParticipantStatus = 'invited' | 'joined' | 'declined' | 'revoked';

export interface BetRow {
  id: string;
  creator_id: string;
  question: string;
  kind: BetKind;
  params: string | null;
  status: BetStatus;
  outcome: string | null;
  outcome_proposed_by: string | null;
  proposal: ProposalKind | null;
  /** Freeform bets: JSON list of the user ids the proposer says were right (empty: nobody). */
  proposed_winners: string | null;
  proposed_at: number | null;
  settle_days: number | null;
  all_in: number;
  stake: number;
  created_at: number;
  started_at: number | null;
  settled_at: number | null;
  settled_by: string | null;
  settled_by_deadline: number;
}

export interface ParticipantRow {
  bet_id: string;
  user_id: string;
  status: ParticipantStatus;
  guess: string | null;
  accepted: number;
  invited_at: number;
  responded_at: number | null;
}

export interface SettlementRow {
  bet_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
}

/** A bet with its people and, once settled, what it moved. */
export interface LoadedBet {
  bet: BetRow;
  participants: ParticipantRow[];
  settlements: SettlementRow[];
}

export const ONGOING_STATUSES = `('awaiting_guess', 'active', 'awaiting_confirmation')`;
const DAY_MS = 86_400_000;

// ---------- loading ----------

const chunks = <T,>(xs: T[], size = 200): T[][] => Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));

async function attach(bets: BetRow[]): Promise<LoadedBet[]> {
  const participants = new Map<string, ParticipantRow[]>();
  const settlements = new Map<string, SettlementRow[]>();
  for (const ids of chunks(bets.map((b) => b.id))) {
    const marks = ids.map(() => '?').join(',');
    const ps = (await db.execute({ sql: `SELECT * FROM bet_participants WHERE bet_id IN (${marks}) ORDER BY invited_at, rowid`, args: ids })).rows as unknown as ParticipantRow[];
    for (const p of ps) participants.set(p.bet_id, [...(participants.get(p.bet_id) ?? []), p]);
    const ss = (await db.execute({ sql: `SELECT * FROM bet_settlements WHERE bet_id IN (${marks})`, args: ids })).rows as unknown as SettlementRow[];
    for (const s of ss) settlements.set(s.bet_id, [...(settlements.get(s.bet_id) ?? []), s]);
  }
  return bets.map((bet) => ({ bet, participants: participants.get(bet.id) ?? [], settlements: settlements.get(bet.id) ?? [] }));
}

/**
 * The bets a user is in or invited to, newest first. Cancelled bets, and ones they declined or were left out of, are
 * left out, unless `all` is asked for (the data export: everything still on record about them).
 */
export async function loadBetsFor(userId: string, opts: { all?: boolean } = {}): Promise<LoadedBet[]> {
  const rows = (
    await db.execute({
      sql: `SELECT b.* FROM bets b JOIN bet_participants p ON p.bet_id = b.id
            WHERE p.user_id = ? ${opts.all ? '' : `AND p.status IN ('invited', 'joined') AND b.status != 'cancelled'`} ORDER BY b.created_at DESC`,
      args: [userId],
    })
  ).rows as unknown as BetRow[];
  return attach(rows);
}

/** One bet, if the user was ever part of it (a declined or revoked invitee still sees what became of it). */
export async function loadBetFor(id: string, userId: string): Promise<LoadedBet | undefined> {
  const rows = (await db.execute({ sql: 'SELECT b.* FROM bets b JOIN bet_participants p ON p.bet_id = b.id WHERE b.id = ? AND p.user_id = ?', args: [id, userId] })).rows as unknown as BetRow[];
  return (await attach(rows))[0];
}

export async function loadBet(id: string): Promise<LoadedBet | undefined> {
  const rows = (await db.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [id] })).rows as unknown as BetRow[];
  return (await attach(rows))[0];
}

/** Everything a user has paid or collected, across all settled bets (balances between friends are sums over these). */
export async function loadSettlementsFor(userId: string): Promise<Transfer[]> {
  const rows = (await db.execute({ sql: 'SELECT * FROM bet_settlements WHERE payer_id = ? OR payee_id = ?', args: [userId, userId] })).rows as unknown as SettlementRow[];
  return rows.map((s) => ({ payerId: s.payer_id, payeeId: s.payee_id, amount: s.amount }));
}

/** GTs each other user owes me. */
export function balances(me: string, settled: Transfer[]): Map<string, number> {
  const by = new Map<string, number>();
  for (const t of settled) {
    const other = t.payeeId === me ? t.payerId : t.payerId === me ? t.payeeId : null;
    if (other === null) continue;
    by.set(other, (by.get(other) ?? 0) + (t.payeeId === me ? t.amount : -t.amount));
  }
  return by;
}

// ---------- reading a bet ----------

/** The players: everyone who is in. Before the bet starts that includes people still deciding on their guess. */
export const playersOf = (lb: LoadedBet) => lb.participants.filter((p) => p.status === 'joined');
export const guessersOf = (lb: LoadedBet): Guesser[] => playersOf(lb).flatMap((p) => (p.guess === null ? [] : [{ id: p.user_id, guess: p.guess }]));
export const participantOf = (lb: LoadedBet, userId: string) => lb.participants.find((p) => p.user_id === userId);
export const isPlayer = (lb: LoadedBet, userId: string) => participantOf(lb, userId)?.status === 'joined';

export const proposalOf = (b: BetRow): ProposalKind | null => (b.status === 'awaiting_confirmation' ? b.proposal : null);

export const tippingPointOf = (lb: LoadedBet): number | null =>
  lb.bet.status === 'active' ? tippingPoint(lb.bet.kind, loadParams(lb.bet.kind, lb.bet.params), guessersOf(lb).map((g) => g.guess)) : null;

/** Who wins under the pending proposal (empty: nobody), or null when nothing is pending. */
export function proposedWinners(lb: LoadedBet): string[] | null {
  const b = lb.bet;
  const kind = proposalOf(b);
  if (kind === null) return null;
  if (kind === 'tie') return [];
  const guessers = guessersOf(lb);
  const won = kind === 'not_happened' ? latestGuessers(b.kind, guessers) : b.kind === 'text' ? parseWinners(b.proposed_winners) : winners(b.kind, guessers, b.outcome!);
  // Everyone winning is a draw: nothing moves, and (since it costs whoever really won) everyone must agree to it
  return won.length >= playersOf(lb).length ? [] : won;
}

const parseWinners = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? [...new Set(v.map(String))] : [];
  } catch {
    return [];
  }
};

/** The bet has started: guesses are out in the open. (Not a bet cancelled before it ever started.) */
export const hasStarted = (b: BetRow) => b.status === 'active' || b.status === 'awaiting_confirmation' || b.status === 'settled';

/** Who wins the settled bet (empty: a draw, or called off). */
export const settledWinners = (lb: LoadedBet): string[] => [...new Set(lb.settlements.map((s) => s.payee_id))];

/**
 * Whose acceptance the pending proposal still needs: everyone except the proposer, and except a sole winner. A sole
 * winner collects the most a player can, so they can't be losing by it; everyone else could be (paying, paying more,
 * or sharing a win they had alone), so a false result always costs someone who is asked. With two players this is
 * "the other player confirms".
 */
export function requiredAcceptors(lb: LoadedBet): ParticipantRow[] {
  const w = proposedWinners(lb);
  if (w === null) return [];
  const soleWinner = w.length === 1 ? w[0] : null;
  return playersOf(lb).filter((p) => p.user_id !== soleWinner && p.user_id !== lb.bet.outcome_proposed_by);
}

export const settleDeadline = (b: BetRow): number | null => (b.status === 'awaiting_confirmation' && b.settle_days && b.proposed_at ? b.proposed_at + b.settle_days * DAY_MS : null);

// ---------- changing a bet ----------

const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/** Makes everyone in the list friends with everyone else, so balances between them have somewhere to live. */
export async function connectAll(ids: string[], now = Date.now()) {
  const stmts = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [x, y] = pair(ids[i], ids[j]);
      stmts.push({ sql: 'INSERT OR IGNORE INTO connections (user_a, user_b, created_at) VALUES (?, ?, ?)', args: [x, y, now] });
    }
  }
  if (stmts.length) await db.batch(stmts, 'write');
}

/** Starts the bet with whoever is in, leaving out anyone who hasn't answered. The players become friends. */
export async function startBet(lb: LoadedBet, now = Date.now()) {
  const players = playersOf(lb).map((p) => p.user_id);
  await db.batch(
    [
      { sql: `UPDATE bet_participants SET status = 'revoked', responded_at = ? WHERE bet_id = ? AND status = 'invited'`, args: [now, lb.bet.id] },
      { sql: `UPDATE bets SET status = 'active', started_at = ? WHERE id = ? AND status = 'awaiting_guess'`, args: [now, lb.bet.id] },
    ],
    'write',
  );
  await connectAll(players, now);
}

export async function cancelBet(id: string) {
  await db.execute({ sql: `UPDATE bets SET status = 'cancelled' WHERE id = ? AND status IN ${ONGOING_STATUSES}`, args: [id] });
}

/**
 * After an invitation is answered, or a guess comes in: the bet starts by itself once nobody is left to answer and
 * everyone in has guessed; with fewer than two players left, it is off.
 */
export async function settleInvitations(id: string, now = Date.now()): Promise<'started' | 'cancelled' | 'waiting'> {
  const lb = await loadBet(id);
  if (!lb || lb.bet.status !== 'awaiting_guess') return 'waiting';
  if (lb.participants.some((p) => p.status === 'invited')) return 'waiting';
  const players = playersOf(lb);
  if (players.length < 2) {
    await cancelBet(id);
    return 'cancelled';
  }
  if (players.some((p) => p.guess === null)) return 'waiting';
  await startBet(lb, now);
  return 'started';
}

/**
 * Records the pending proposal as settled: winners collect from everyone else (nothing moves for a tie or a draw).
 * One transaction, and only if the bet still carries exactly the proposal that was loaded (same `proposed_at`): a
 * counter-proposal, rejection or cancellation in between leaves the balances alone. Returns whether it settled.
 */
export async function settleBet(lb: LoadedBet, opts: { now?: number; byDeadline?: boolean } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const kind = proposalOf(lb.bet);
  if (!kind) throw new Error('Nothing to settle');
  const won = proposedWinners(lb)!;
  const moves = transfers(playersOf(lb).map((p) => p.user_id), won, lb.bet.stake);
  const tx = await db.transaction('write');
  try {
    const r = await tx.execute({
      sql: `UPDATE bets SET status = 'settled', settled_at = ?, settled_by = ?, settled_by_deadline = ?, proposal = NULL
            WHERE id = ? AND status = 'awaiting_confirmation' AND proposal = ? AND outcome_proposed_by = ? AND proposed_at IS ?`,
      args: [now, kind === 'tie' ? 'tie' : kind === 'not_happened' ? 'tipping_point' : 'outcome', opts.byDeadline ? 1 : 0, lb.bet.id, kind, lb.bet.outcome_proposed_by, lb.bet.proposed_at],
    });
    if (r.rowsAffected !== 1) {
      await tx.rollback();
      return false;
    }
    await tx.execute({ sql: 'DELETE FROM bet_settlements WHERE bet_id = ?', args: [lb.bet.id] });
    for (const t of moves) await tx.execute({ sql: 'INSERT INTO bet_settlements (bet_id, payer_id, payee_id, amount) VALUES (?, ?, ?, ?)', args: [lb.bet.id, t.payerId, t.payeeId, t.amount] });
    await tx.commit();
    return true;
  } catch (e) {
    await tx.rollback().catch(() => undefined);
    throw e;
  } finally {
    tx.close();
  }
}

/** Settles the pending proposal if everyone whose acceptance it needs has accepted. */
export async function settleIfAccepted(id: string, now = Date.now()): Promise<boolean> {
  const lb = await loadBet(id);
  if (!lb || lb.bet.status !== 'awaiting_confirmation') return false;
  if (requiredAcceptors(lb).some((p) => !p.accepted)) return false;
  return settleBet(lb, { now });
}

/** Drops the pending proposal; the bet is back in play. */
export async function clearProposal(id: string) {
  await db.batch(
    [
      { sql: `UPDATE bets SET outcome = NULL, outcome_proposed_by = NULL, proposed_winners = NULL, proposal = NULL, proposed_at = NULL, status = 'active' WHERE id = ?`, args: [id] },
      { sql: 'UPDATE bet_participants SET accepted = 0 WHERE bet_id = ?', args: [id] },
    ],
    'write',
  );
}

// ---------- the API's view ----------

export interface Viewer {
  id: string;
  /** Everyone who might appear in the bet, by id. */
  users: Map<string, UserSummary>;
  /** GTs each friend owes the viewer, across every settled bet. */
  balances: Map<string, number>;
  /** All of the viewer's bets, to tell whether another all-in with the same friend is already open. */
  allBets: LoadedBet[];
}

export function serializeBet(lb: LoadedBet, v: Viewer, now = Date.now()): Bet {
  const b = lb.bet;
  const me = v.id;
  const mine = participantOf(lb, me);
  const started = hasStarted(b);
  const players = playersOf(lb);
  const pending = proposedWinners(lb);
  const winnerIds = pending ?? (b.status === 'settled' ? settledWinners(lb) : []);
  const won = new Set(winnerIds);
  const required = new Set(requiredAcceptors(lb).map((p) => p.user_id));
  const tp = tippingPointOf(lb);
  const tippingPassed = tp !== null && now >= tp;
  const iAmCreator = b.creator_id === me;
  const myGuess = mine?.guess ?? null;
  const iMustAccept = required.has(me);
  const iAccepted = !!mine?.accepted;
  const canStart = iAmCreator && b.status === 'awaiting_guess' && myGuess !== null && players.filter((p) => p.guess !== null).length >= 2 && lb.participants.some((p) => p.status === 'invited');
  const needsMyAction =
    (b.status === 'awaiting_guess' && mine?.status !== 'declined' && mine?.status !== 'revoked' && myGuess === null) ||
    (b.status === 'awaiting_confirmation' && iMustAccept && !iAccepted) ||
    tippingPassed; // everyone is asked whether the event has happened
  // The people in the bet: those who joined and, before the start, those still deciding
  const inBet = lb.participants.filter((p) => p.status === 'joined' || (p.status === 'invited' && !started));
  const other = inBet.length === 2 && inBet.some((p) => p.user_id === me) ? inBet.find((p) => p.user_id !== me)!.user_id : null;
  const debt = other === null ? 0 : -(v.balances.get(other) ?? 0);
  const anotherAllInOpen = other !== null && v.allBets.some((x) => x.bet.id !== b.id && x.bet.all_in && (x.bet.status === 'active' || x.bet.status === 'awaiting_confirmation') && isPlayer(x, other));
  const owesMe = (id: string) => lb.settlements.reduce((sum, s) => (s.payee_id === me && s.payer_id === id ? sum + s.amount : s.payer_id === me && s.payee_id === id ? sum - s.amount : sum), 0);

  const participants: Participant[] = lb.participants.map((p) => {
    const u = v.users.get(p.user_id) ?? { id: p.user_id, name: 'Friend', hasAvatar: false, avatarVersion: 0, deleted: false };
    const isMe = p.user_id === me;
    return {
      ...u,
      status: p.status,
      isMe,
      isCreator: p.user_id === b.creator_id,
      guessIn: p.guess !== null,
      // Guesses stay secret until the bet starts. This is the only place guesses leave the server, and nothing
      // derived from them (tipping point, verdicts) is exposed before that either.
      guess: isMe || started ? p.guess : null,
      winner: won.has(p.user_id),
      mustAccept: required.has(p.user_id),
      accepted: !!p.accepted,
      owesMe: isMe ? 0 : owesMe(p.user_id),
    };
  });

  return {
    id: b.id,
    question: b.question,
    kind: b.kind,
    params: loadParams(b.kind, b.params),
    status: b.status,
    creatorId: b.creator_id,
    iAmCreator,
    participants,
    otherUserId: other,
    myGuess,
    outcome: b.outcome,
    outcomeProposedBy: b.outcome_proposed_by,
    outcomeProposedByMe: b.outcome_proposed_by ? b.outcome_proposed_by === me : null,
    proposalKind: proposalOf(b),
    proposalId: proposalOf(b) ? b.proposed_at : null,
    winnerIds,
    iMustAccept,
    iAccepted,
    settleDays: b.settle_days ?? null,
    settleDeadline: settleDeadline(b),
    settledBy: b.status === 'settled' ? (b.settled_by === 'tipping_point' || b.settled_by === 'tie' ? b.settled_by : 'outcome') : null,
    settledByDeadline: b.status === 'settled' && !!b.settled_by_deadline,
    myNet: participants.reduce((sum, p) => sum + p.owesMe, 0),
    allIn: !!b.all_in,
    stake: b.stake,
    tippingPoint: tp,
    tippingSoon: tp !== null && tp > now && tp - now <= 48 * 3_600_000,
    tippingPassed,
    needsMyAction,
    canStart,
    // Going all-in on a 1 GT debt would be no different from the regular 1 GT bet, so it takes at least 2 GTs of debt.
    canAllIn: b.status === 'active' && !b.all_in && players.length === 2 && debt >= 2 && !anotherAllInOpen,
    allInStake: Math.max(debt, 0),
    createdAt: b.created_at,
    startedAt: b.started_at,
    settledAt: b.settled_at,
  };
}
