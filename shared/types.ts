export type BetKind = 'number' | 'date';

export type BetStatus =
  | 'awaiting_guess' // creator has guessed, opponent has not
  | 'active' // both guessed, waiting for the real outcome
  | 'awaiting_confirmation' // one side proposed the outcome, the other must confirm
  | 'settled'
  | 'cancelled';

export interface UserSummary {
  id: string;
  name: string;
  hasAvatar: boolean;
  avatarVersion: number;
}

export interface Me extends UserSummary {
  email: string | null;
}

export interface Friend extends UserSummary {
  /** Beers the friend owes me; negative means I owe them. */
  balance: number;
  openBets: number;
  needsMyAction: number;
}

export interface Bet {
  id: string;
  question: string;
  kind: BetKind;
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
  needsMyAction: boolean;
  canAllIn: boolean;
  /** Beers I'd put on the line if I went all-in now. */
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
