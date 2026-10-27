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
  `CREATE TABLE IF NOT EXISTS email_verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    opponent_id TEXT NOT NULL,
    question TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    creator_guess TEXT NOT NULL,
    opponent_guess TEXT,
    outcome TEXT,
    outcome_proposed_by TEXT,
    winner_id TEXT,
    all_in INTEGER NOT NULL DEFAULT 0,
    stake INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS bet_reminders (
    bet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (bet_id, kind)
  )`,
];

/** Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first. */
async function migrate() {
  const cols = (await db.execute('PRAGMA table_info(bets)')).rows.map((r) => r.name);
  if (!cols.includes('params')) await db.execute('ALTER TABLE bets ADD COLUMN params TEXT');
  if (!cols.includes('settled_by')) await db.execute('ALTER TABLE bets ADD COLUMN settled_by TEXT');
  // What a pending proposal says: 'outcome' | 'not_happened' | 'tie' (older rows: inferred from outcome)
  if (!cols.includes('proposal')) await db.execute('ALTER TABLE bets ADD COLUMN proposal TEXT');
  // 'date' bets became 'instant' bets with day precision and no restrictions
  await db.execute(`UPDATE bets SET kind = 'instant', params = '{"precision":"day","allowPast":true,"minLeadMinutes":0}' WHERE kind = 'date'`);
  await db.execute(`UPDATE bets SET settled_by = 'outcome' WHERE status = 'settled' AND settled_by IS NULL`);
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
