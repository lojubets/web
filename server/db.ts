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
