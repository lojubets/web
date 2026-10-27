export type BetKind = 'number' | 'duration' | 'instant';

/** Rules for a numeric answer. Applied to guesses, not to the real-world outcome. */
export interface NumberParams {
  integer: boolean;
  min: number | null;
  max: number | null;
  minExclusive: boolean;
  maxExclusive: boolean;
}

/** Rules for a date or date-and-time answer. */
export interface InstantParams {
  /** 'day' answers are YYYY-MM-DD; 'minute' answers are UTC ISO timestamps. */
  precision: 'day' | 'minute';
  /** When false, the event is in the future, which also enables the tipping point. */
  allowPast: boolean;
  /** Guesses must be at least this far in the future when placed (only when !allowPast). */
  minLeadMinutes: number;
}

export type DurationParams = Record<string, never>;
export type BetParams = NumberParams | InstantParams | DurationParams;

export type BetStatus =
  | 'awaiting_guess' // creator has guessed, opponent has not
  | 'active' // both guessed, waiting for the real outcome
  | 'awaiting_confirmation' // one side proposed the outcome, the other must confirm
  | 'settled'
  | 'cancelled';

export interface UserSummary {
  id: string;
  /** Display name, or the email address when the user hasn't set one. Never empty. */
  name: string;
  hasAvatar: boolean;
  avatarVersion: number;
}

export interface Me extends UserSummary {
  /** The display name the user chose; empty when not set. */
  profileName: string;
  email: string | null;
  emailVerified: boolean;
}

export interface Friend extends UserSummary {
  /** Lonkeros the friend owes me; negative means I owe them. */
  balance: number;
  openBets: number;
  needsMyAction: number;
}

export interface Bet {
  id: string;
  question: string;
  kind: BetKind;
  params: BetParams;
  status: BetStatus;
  otherUserId: string;
  iAmCreator: boolean;
  myGuess: string | null;
  /** Hidden from the creator's opponent until both have guessed. */
  theirGuess: string | null;
  outcome: string | null;
  outcomeProposedByMe: boolean | null;
  /** null while unsettled or on a draw */
  winnerId: string | null;
  allIn: boolean;
  stake: number;
  /** Settled by a confirmed outcome, by both players confirming the event hadn't happened by the tipping point, or by both agreeing to call it off as a tie. */
  settledBy: 'outcome' | 'tipping_point' | 'tie' | null;
  /** What the pending proposal says: a result, or "the event hasn't happened yet". */
  proposalKind: 'outcome' | 'not_happened' | 'tie' | null;
  /**
   * Future-dated bets only: once this moment passes with the event still pending, the later guess
   * is guaranteed to be closer. The players are asked whether the event has happened; nothing is assumed.
   */
  tippingPoint: number | null;
  tippingSoon: boolean;
  /** In play, tipping point passed, nobody has answered "has it happened?" yet. */
  tippingPassed: boolean;
  needsMyAction: boolean;
  canAllIn: boolean;
  /** Lonkeros I'd put on the line if I went all-in now. */
  allInStake: number;
  createdAt: number;
  settledAt: number | null;
}

export interface Invitation {
  id: string;
  email: string;
  token: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  inviter: UserSummary;
  createdAt: number;
}

export interface AppConfig {
  providers: ('google' | 'microsoft' | 'apple')[];
  devLogin: boolean;
}
