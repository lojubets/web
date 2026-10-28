export type BetKind = 'number' | 'duration' | 'instant' | 'text' | 'yesno' | 'choice';

/** Kinds where an answer is right or wrong rather than closer or further. */
export const EXACT_KINDS: readonly BetKind[] = ['yesno', 'choice'];

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
export type TextParams = Record<string, never>;
export type YesNoParams = Record<string, never>;

/** The options a multiple-choice bet offers; an answer is one of them, written exactly as listed. */
export interface ChoiceParams {
  options: string[];
}

export type BetParams = NumberParams | InstantParams | DurationParams | TextParams | YesNoParams | ChoiceParams;

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
  /** A placeholder standing in for someone who deleted their account. */
  deleted: boolean;
}

export interface EmailAddress {
  email: string;
  verified: boolean;
  primary: boolean;
}

/** An address on the signed-in user's own account. */
export interface OwnEmailAddress extends EmailAddress {
  /** This address is also a login: you can sign in with it and your password. */
  signsInWithPassword: boolean;
  /** Removing this address moves its password login to this other verified address, because it is the account's only login. */
  movesPasswordTo: string | null;
  /** Why it can't be removed right now, or null if it can. */
  removeBlocked: string | null;
}

/** A way of signing in to the signed-in user's own account. */
export interface OwnLogin {
  provider: string;
  /** The provider's id for the person; for a password login, the email address it uses. */
  subject: string;
  /** What to show: "Google", or "Email and password" with `email` set. */
  label: string;
  /** The address of a password login. */
  email: string | null;
  /** For a provider login, the email that account at the provider uses (null until it has signed in since this was recorded). */
  account: string | null;
  /** Why it can't be removed right now, or null if it can. */
  removeBlocked: string | null;
}

export interface Me extends UserSummary {
  /** Every way of signing in to the account. */
  logins: OwnLogin[];
  /** Every address on the account, the primary first, each with its own verification status. */
  emails: OwnEmailAddress[];
  /** The display name the user chose; empty when not set. */
  profileName: string;
  email: string | null;
  emailVerified: boolean;
  /** When the user asked to delete their account, while it waits on ongoing bets. */
  deletionRequestedAt: number | null;
}

export interface Friend extends UserSummary {
  /** GTs the friend owes me; negative means I owe them. */
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
  /** Hidden until both have guessed. */
  theirGuess: string | null;
  /** While the bet waits for guesses: whether they have locked theirs in (the guess itself stays hidden). */
  theirGuessIn: boolean;
  outcome: string | null;
  outcomeProposedByMe: boolean | null;
  /**
   * Freeform bets only: who the proposer says was right (a person can't compute closeness of free text),
   * from the viewer's point of view. The other player confirms or rejects it.
   */
  proposedVerdict: 'me' | 'them' | 'draw' | null;
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
  /** GTs I'd put on the line if I went all-in now. */
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
  /** Contact address for privacy requests, from the PRIVACY_CONTACT_EMAIL environment variable. */
  privacyContactEmail: string | null;
}

/** One of the two accounts in a merge. */
export interface MergeSide {
  id: string;
  /** Display name, or the email when none is set. */
  name: string;
  /** The display name the user chose; empty when not set. */
  profileName: string;
  hasAvatar: boolean;
  avatarVersion: number;
  primaryEmail: string | null;
  emails: EmailAddress[];
  friends: number;
  bets: number;
}

export interface MergePreview {
  /** The account you're signed in to; it is the one that remains. */
  a: MergeSide;
  /** The account being merged into it. */
  b: MergeSide;
  /** Reasons the merge can't go ahead yet. */
  blockers: string[];
  /** Both accounts sign in with a password. The merged account gets exactly one, so a new one must be chosen. */
  needsNewPassword: boolean;
  /** Finished bets between the two accounts, which would be removed (a bet with yourself is meaningless). */
  betsBetween: number;
}

export interface MergeChoices {
  email: 'a' | 'b';
  name: 'a' | 'b';
  photo: 'a' | 'b' | 'none';
}

/** What the signed-in user's pending or possible account deletion looks like. */
export interface DeletionStatus {
  requestedAt: number | null;
  lapseDays: number;
  ongoing: {
    betId: string;
    question: string;
    status: BetStatus;
    other: { id: string; name: string };
    request: { response: 'pending' | 'accepted' | 'refused' | 'lapsed'; createdAt: number; lapsesAt: number } | null;
  }[];
}

/** Someone who is deleting their account asks to cancel a bet with me. */
export interface CancelRequest {
  betId: string;
  question: string;
  status: BetStatus;
  from: { id: string; name: string };
  createdAt: number;
  lapsesAt: number;
}
