import { createClient } from '@libsql/client';
import { env } from './env.js';

export const db = createClient({ url: env.databaseUrl, authToken: env.databaseAuthToken });

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS users_email ON users (lower(email))`,
  `CREATE TABLE IF NOT EXISTS avatars (
    user_id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
  )`,
  // Every email address an account has, with its own verification status. users.email is the primary one.
  `CREATE TABLE IF NOT EXISTS user_emails (
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, email)
  )`,
  `CREATE INDEX IF NOT EXISTS user_emails_email ON user_emails (email)`,
  // Password per login (the email it was registered with), so a merged account can keep several.
  `CREATE TABLE IF NOT EXISTS password_credentials (
    subject TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  )`,
  // Superseded by password_credentials; kept so the migration below can read old rows.
  `CREATE TABLE IF NOT EXISTS credentials (
    user_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  )`,
  // Fixed-window counters for login throttling; one row per key, shared by every serverless instance.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS email_verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // One-time password reset links: only the hash of the token is kept, and the link belongs to a password login (its email).
  `CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // user_a < user_b always, so each pair is stored once
  `CREATE TABLE IF NOT EXISTS connections (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_a, user_b)
  )`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    inviter_id TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  )`,
  // A bet between two or more players. Who plays, and their guesses, live in bet_participants; what the settled
  // bet moved between them in bet_settlements. (Older databases had a two-player shape; `migrate` rebuilds it.)
  `CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    question TEXT NOT NULL,
    kind TEXT NOT NULL,
    params TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    outcome_proposed_by TEXT,
    proposal TEXT,
    proposed_winners TEXT,
    proposed_at INTEGER,
    settle_days INTEGER,
    all_in INTEGER NOT NULL DEFAULT 0,
    stake INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    settled_at INTEGER,
    settled_by TEXT,
    settled_by_deadline INTEGER NOT NULL DEFAULT 0
  )`,
  // status: 'invited' (asked, not answered) | 'joined' (in, with a guess once the bet starts) | 'declined' | 'revoked'
  // (the creator started the bet without them). `accepted` is their answer to the pending proposal.
  `CREATE TABLE IF NOT EXISTS bet_participants (
    bet_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    guess TEXT,
    accepted INTEGER NOT NULL DEFAULT 0,
    invited_at INTEGER NOT NULL,
    responded_at INTEGER,
    PRIMARY KEY (bet_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS bet_participants_user ON bet_participants (user_id)`,
  // What a settled bet moved: payer owes payee `amount` GTs. Balances between friends are sums over these rows.
  `CREATE TABLE IF NOT EXISTS bet_settlements (
    bet_id TEXT NOT NULL,
    payer_id TEXT NOT NULL,
    payee_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (bet_id, payer_id, payee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS bet_settlements_payer ON bet_settlements (payer_id)`,
  `CREATE INDEX IF NOT EXISTS bet_settlements_payee ON bet_settlements (payee_id)`,
  // A user who is deleting their account asks the other bettor to cancel an ongoing bet. See docs/account-deletion.md.
  `CREATE TABLE IF NOT EXISTS bet_cancel_requests (
    bet_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    response TEXT NOT NULL DEFAULT 'pending',
    responded_at INTEGER,
    reminded_7_at INTEGER,
    reminded_23_at INTEGER,
    PRIMARY KEY (bet_id, requested_by)
  )`,
  `CREATE TABLE IF NOT EXISTS bet_reminders (
    bet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (bet_id, kind)
  )`,
];

/**
 * Databases from before group bets hold each bet in one row with two players (creator_id/opponent_id, two guess
 * columns, winner_id). Their players, guesses and results move to bet_participants and bet_settlements, and the
 * bets table is rebuilt in its current shape. One transaction; a no-op once done.
 */
async function migrateTwoPlayerBets(cols: unknown[]) {
  if (!cols.includes('opponent_id')) return;
  if (!cols.includes('params')) await db.execute('ALTER TABLE bets ADD COLUMN params TEXT');
  if (!cols.includes('settled_by')) await db.execute('ALTER TABLE bets ADD COLUMN settled_by TEXT');
  if (!cols.includes('proposal')) await db.execute('ALTER TABLE bets ADD COLUMN proposal TEXT');
  if (!cols.includes('proposed_verdict')) await db.execute('ALTER TABLE bets ADD COLUMN proposed_verdict TEXT');
  await db.execute(`UPDATE bets SET kind = 'instant', params = '{"precision":"day","allowPast":true,"minLeadMinutes":0}' WHERE kind = 'date'`);
  await db.execute(`UPDATE bets SET settled_by = 'outcome' WHERE status = 'settled' AND settled_by IS NULL`);
  const S = (sql: string) => ({ sql, args: [] });
  await db.batch(
    [
      // The creator is always in; an empty guess meant "not guessed yet" (or a deleted user's removed guess)
      S(`INSERT OR IGNORE INTO bet_participants (bet_id, user_id, status, guess, accepted, invited_at, responded_at)
         SELECT id, creator_id, 'joined', NULLIF(creator_guess, ''), 0, created_at, created_at FROM bets`),
      // The opponent joined by guessing; one who never answered a cancelled bet had declined it
      S(`INSERT OR IGNORE INTO bet_participants (bet_id, user_id, status, guess, accepted, invited_at, responded_at)
         SELECT id, opponent_id,
                CASE WHEN opponent_guess IS NOT NULL OR status = 'settled' THEN 'joined' WHEN status = 'cancelled' THEN 'declined' ELSE 'invited' END,
                NULLIF(opponent_guess, ''), 0, created_at, CASE WHEN opponent_guess IS NOT NULL THEN created_at END
         FROM bets`),
      S(`INSERT OR IGNORE INTO bet_settlements (bet_id, payer_id, payee_id, amount)
         SELECT id, CASE WHEN winner_id = creator_id THEN opponent_id ELSE creator_id END, winner_id, stake
         FROM bets WHERE status = 'settled' AND winner_id IS NOT NULL`),
      S(`CREATE TABLE bets_v2 (
           id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, question TEXT NOT NULL, kind TEXT NOT NULL, params TEXT, status TEXT NOT NULL,
           outcome TEXT, outcome_proposed_by TEXT, proposal TEXT, proposed_winners TEXT, proposed_at INTEGER, settle_days INTEGER,
           all_in INTEGER NOT NULL DEFAULT 0, stake INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, started_at INTEGER,
           settled_at INTEGER, settled_by TEXT, settled_by_deadline INTEGER NOT NULL DEFAULT 0)`),
      // A pending proposal: 'outcome' unless the column says otherwise (rows from before it existed had the outcome set, or
      // were "not happened" claims); a freeform verdict becomes the list of winners it named. Ids are UUIDs, so no quoting issues.
      S(`INSERT INTO bets_v2 (id, creator_id, question, kind, params, status, outcome, outcome_proposed_by, proposal, proposed_winners, proposed_at,
                              settle_days, all_in, stake, created_at, started_at, settled_at, settled_by)
         SELECT id, creator_id, question, kind, params, status, outcome, outcome_proposed_by,
                CASE WHEN status != 'awaiting_confirmation' THEN NULL ELSE COALESCE(proposal, CASE WHEN outcome IS NULL THEN 'not_happened' ELSE 'outcome' END) END,
                CASE proposed_verdict WHEN 'creator' THEN '["' || creator_id || '"]' WHEN 'opponent' THEN '["' || opponent_id || '"]' WHEN 'draw' THEN '[]' END,
                CASE WHEN status = 'awaiting_confirmation' THEN created_at END,
                NULL, all_in, stake, created_at, CASE WHEN status != 'awaiting_guess' AND status != 'cancelled' THEN created_at END, settled_at, settled_by
         FROM bets`),
      S('DROP TABLE bets'),
      S('ALTER TABLE bets_v2 RENAME TO bets'),
    ],
    'write',
  );
}

/**
 * A pending proposal that needs nobody's acceptance (one from before the rules changed, whose proposer loses by it)
 * is settled rather than left waiting for a confirmation nobody is asked for. Runs on every start, since it is cheap
 * and idempotent, so a start that stopped halfway through the rebuild above can't leave one behind.
 * (Imported here, not at the top: bets.ts needs db.)
 */
async function settlePendingProposals() {
  const { settleIfAccepted } = await import('./bets.js');
  for (const r of (await db.execute(`SELECT id FROM bets WHERE status = 'awaiting_confirmation'`)).rows) await settleIfAccepted(String(r.id));
}

/** Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first. */
async function migrate() {
  await migrateTwoPlayerBets((await db.execute('PRAGMA table_info(bets)')).rows.map((r) => r.name));
  await settlePendingProposals();
  const userCols = (await db.execute('PRAGMA table_info(users)')).rows.map((r) => r.name);
  // Account deletion: a pending request, and the marker on the placeholder that stands in for a deleted user
  if (!userCols.includes('deletion_requested_at')) await db.execute('ALTER TABLE users ADD COLUMN deletion_requested_at INTEGER');
  if (!userCols.includes('deleted_at')) await db.execute('ALTER TABLE users ADD COLUMN deleted_at INTEGER');
  // Which account at the provider a login is (the email it shared), so people with several can tell them apart
  const identityCols = (await db.execute('PRAGMA table_info(identities)')).rows.map((r) => r.name);
  if (!identityCols.includes('account')) await db.execute('ALTER TABLE identities ADD COLUMN account TEXT');
  // Bumping this signs the account out everywhere: session tokens carry the version they were issued under.
  if (!userCols.includes('session_version')) await db.execute('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  // Multi-email and per-login passwords (idempotent: INSERT OR IGNORE never overwrites)
  await db.execute(
    `INSERT OR IGNORE INTO user_emails (user_id, email, verified, created_at)
     SELECT id, lower(email), email_verified, created_at FROM users WHERE email IS NOT NULL AND email != ''`,
  );
  await db.execute(
    `INSERT OR IGNORE INTO password_credentials (subject, password_hash)
     SELECT i.subject, c.password_hash FROM credentials c JOIN identities i ON i.user_id = c.user_id AND i.provider = 'password'`,
  );
}

let ready: Promise<void> | undefined;
export function ensureSchema() {
  ready ??= db
    .batch(schema.map((sql) => ({ sql, args: [] })), 'write')
    .then(migrate)
    .catch((e) => {
      ready = undefined;
      throw e;
    });
  return ready;
}
