import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mails: { to: string; subject: string; text: string }[] = [];
vi.mock('./email.js', () => ({
  mailConfigured: () => true,
  sendMail: async (to: string, subject: string, text: string) => (mails.push({ to, subject, text }), true),
  sendInviteEmail: async () => false,
}));
import app from './app.js';
import { db } from './db.js';
import { runDeletionCron } from './deletion.js';

type Agent = ReturnType<typeof request.agent>;
const DAY = 86_400_000;
let n = 0;

/** A signed-in (dev login, so verified) user. */
async function user(name: string) {
  const email = `${name.toLowerCase()}${n++}@example.com`;
  const a = request.agent(app);
  await a.post('/api/auth/dev').send({ name, email }).expect(200);
  return { a, email, id: (await a.get('/api/me')).body.id as string };
}

async function befriend(x: { a: Agent }, y: { email: string; a: Agent }) {
  const { body } = await x.a.post('/api/invitations').send({ email: y.email }).expect(201);
  await y.a.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);
}

async function newBet(x: { a: Agent }, y: { id: string; a: Agent }, answer = true) {
  const { body } = await x.a.post('/api/bets').send({ opponentId: y.id, question: 'Goals?', kind: 'number', guess: '2' }).expect(201);
  if (answer) await y.a.post(`/api/bets/${body.id}/guess`).send({ guess: '5' }).expect(200);
  return body.id as string;
}

async function settle(x: { a: Agent }, y: { a: Agent }, id: string) {
  await x.a.post(`/api/bets/${id}/propose`).send({ outcome: '3' }).expect(200);
  await y.a.post(`/api/bets/${id}/confirm`).expect(200);
}

const requestDeletion = (u: { a: Agent }, extra: object = {}) => u.a.post('/api/me/deletion').send({ confirm: 'DELETE', ...extra });
const exists = async (id: string) => (await db.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [id] })).rows.length > 0;

beforeEach(() => {
  mails.length = 0;
});

describe('deleting an account with nothing ongoing', () => {
  it('asks for the typed confirmation and the password', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/register').send({ email: 'pw@example.com', password: 'correct horse' }).expect(201);
    const token = mails.at(-1)!.text.match(/token=([\w-]+)/)![1];
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);

    await a.post('/api/me/deletion').send({ confirm: 'delete', password: 'correct horse' }).expect(400);
    await a.post('/api/me/deletion').send({ confirm: 'DELETE', password: 'wrong password' }).expect(401);
    const { body } = await a.post('/api/me/deletion').send({ confirm: 'DELETE', password: 'correct horse' }).expect(200);
    expect(body.deleted).toBe(true);
    await a.get('/api/me').expect(401); // the session is gone with the account
    await request(app).post('/api/auth/login').send({ email: 'pw@example.com', password: 'correct horse' }).expect(401);
  });

  it('wants a recent sign-in from accounts that only use a provider', async () => {
    const u = await user('Fresh');
    await requestDeletion(u).expect(200); // just signed in
    const { rows } = await db.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [u.id] });
    expect(rows).toHaveLength(0);
  });

  it('removes every trace of the person', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    await ann.a.put('/api/me/avatar').send({ dataUrl: 'data:image/png;base64,AAAA' }).expect(200);
    await bob.a.post('/api/invitations').send({ email: 'someone@example.com' }).expect(201);
    await ann.a.post('/api/invitations').send({ email: 'third@example.com' }).expect(201);
    // an invitation addressed to Ann by a third person
    await db.execute({ sql: `INSERT INTO invitations (id, token, inviter_id, email, status, created_at) VALUES ('x', 'tok', ?, ?, 'pending', 1)`, args: [bob.id, ann.email] });
    mails.length = 0;

    expect((await requestDeletion(ann).expect(200)).body.deleted).toBe(true);

    for (const table of ['users', 'user_emails', 'identities', 'avatars', 'email_verifications']) {
      const col = table === 'users' ? 'id' : table === 'identities' ? 'user_id' : 'user_id';
      expect((await db.execute({ sql: `SELECT 1 FROM ${table} WHERE ${col} = ?`, args: [ann.id] })).rows, table).toHaveLength(0);
    }
    expect((await db.execute({ sql: 'SELECT 1 FROM connections WHERE user_a = ? OR user_b = ?', args: [ann.id, ann.id] })).rows).toHaveLength(0);
    expect((await db.execute({ sql: 'SELECT 1 FROM invitations WHERE inviter_id = ? OR lower(email) = ?', args: [ann.id, ann.email] })).rows).toHaveLength(0);
    // Bob's friends list no longer has her, and her address appears nowhere in the database
    expect((await bob.a.get('/api/friends')).body).toEqual([]);
    for (const t of ['users', 'user_emails', 'invitations', 'identities', 'bets', 'connections']) {
      const all = JSON.stringify((await db.execute(`SELECT * FROM ${t}`)).rows);
      expect(all, t).not.toContain(ann.email);
    }
    expect(mails.map((m) => m.to)).toEqual([ann.email]); // the goodbye note, and nothing to anyone else
  });
});

describe('settled and cancelled bets of a deleted user', () => {
  it('keeps the result and balance, shows "Deleted user", and can be removed from the other history', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const won = await newBet(ann, bob);
    await settle(ann, bob, won); // Ann guessed 2, Bob 5, outcome 3: Ann wins
    const cancelled = await newBet(bob, ann, false);
    await bob.a.post(`/api/bets/${cancelled}/cancel`).expect(200);
    const before = (await bob.a.get('/api/friends')).body[0].balance;
    expect(before).toBe(-1);

    await requestDeletion(ann).expect(200);

    const friends = (await bob.a.get('/api/friends')).body;
    expect(friends).toHaveLength(1);
    expect(friends[0]).toMatchObject({ name: 'Deleted user', deleted: true, balance: -1 });
    const bets = (await bob.a.get('/api/bets')).body;
    expect(bets).toHaveLength(1); // the cancelled one is gone
    expect(bets[0]).toMatchObject({ question: 'Goals?', status: 'settled', myGuess: '5', theirGuess: null, otherUserId: friends[0].id });
    expect((await db.execute({ sql: 'SELECT * FROM bets WHERE id = ?', args: [cancelled] })).rows).toHaveLength(0);

    // Nobody can start something new with the placeholder
    await bob.a.post('/api/bets').send({ opponentId: friends[0].id, question: 'Again?', kind: 'number', guess: '1' }).expect(409);

    await bob.a.post(`/api/bets/${won}/remove-from-history`).expect(200);
    expect((await bob.a.get('/api/bets')).body).toEqual([]);
    expect((await bob.a.get('/api/friends')).body).toEqual([]);
    expect((await db.execute('SELECT 1 FROM users WHERE deleted_at IS NOT NULL')).rows).toHaveLength(0);
  });

  it("won't remove a bet against someone who is still around", async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await settle(ann, bob, id);
    await bob.a.post(`/api/bets/${id}/remove-from-history`).expect(404);
  });

  it('gives each deleted person their own placeholder', async () => {
    const bob = await user('Bob');
    const ids = [];
    for (const name of ['Ann', 'Cy']) {
      const u = await user(name);
      await befriend(u, bob);
      await settle(u, bob, await newBet(u, bob));
      await requestDeletion(u).expect(200);
      ids.push(u.id);
    }
    const friends = (await bob.a.get('/api/friends')).body;
    expect(friends.map((f: any) => f.name)).toEqual(['Deleted user', 'Deleted user']);
    expect(new Set(friends.map((f: any) => f.id)).size).toBe(2);
    expect(friends.map((f: any) => f.id)).not.toContain(ids[0]);
  });
});

describe('deleting with ongoing bets', () => {
  it('cancels bets nobody answered, but waits on the rest', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const unanswered = await newBet(ann, bob, false);
    const active = await newBet(ann, bob);

    const { body } = await requestDeletion(ann).expect(200);
    expect(body.deleted).toBe(false);
    expect((await db.execute({ sql: 'SELECT status FROM bets WHERE id = ?', args: [unanswered] })).rows[0].status).toBe('cancelled');
    expect((await bob.a.get(`/api/bets/${active}`)).body.status).toBe('active');

    const status = (await ann.a.get('/api/me/deletion')).body;
    expect(status.ongoing).toHaveLength(1);
    expect(status.ongoing[0]).toMatchObject({ betId: active, request: { response: 'pending' } });

    const incoming = (await bob.a.get('/api/me/cancel-requests')).body;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ betId: active, from: { name: 'Ann' } });
    expect(mails.some((m) => m.to === bob.email && /asks to cancel/.test(m.subject))).toBe(true);
    expect((await ann.a.get('/api/me')).body.deletionRequestedAt).toBeGreaterThan(0);

    // While it waits: no new bets or invitations, either way
    await ann.a.post('/api/bets').send({ opponentId: bob.id, question: 'More?', kind: 'number', guess: '1' }).expect(409);
    await bob.a.post('/api/bets').send({ opponentId: ann.id, question: 'More?', kind: 'number', guess: '1' }).expect(409);
    await ann.a.post('/api/invitations').send({ email: 'new@example.com' }).expect(409);
  });

  it('is erased as soon as the counterparty accepts', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);

    await ann.a.post(`/api/bets/${id}/cancel-request/accept`).expect(404); // not hers to answer
    await bob.a.post(`/api/bets/${id}/cancel-request/accept`).expect(200);
    expect(await exists(ann.id)).toBe(false);
    expect((await bob.a.get('/api/bets')).body).toEqual([]);
  });

  it('is erased when the last bet is settled the normal way', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);
    expect(await exists(ann.id)).toBe(true);
    await settle(bob, ann, id);
    expect(await exists(ann.id)).toBe(false);
    expect((await bob.a.get('/api/bets')).body[0]).toMatchObject({ status: 'settled' });
  });

  it('keeps waiting after a refusal, however long', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);
    await bob.a.post(`/api/bets/${id}/cancel-request/refuse`).expect(200);

    await runDeletionCron(Date.now() + 90 * DAY);
    expect(await exists(ann.id)).toBe(true);
    expect((await bob.a.get(`/api/bets/${id}`)).body.status).toBe('active');
  });

  it("cancels the bet and erases after 30 days of silence, with reminders on the way", async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);
    const start = Date.now();
    mails.length = 0;

    await runDeletionCron(start + 3 * DAY);
    expect(mails).toHaveLength(0);
    await runDeletionCron(start + 8 * DAY);
    await runDeletionCron(start + 9 * DAY); // not twice
    expect(mails.filter((m) => /Reminder/.test(m.subject))).toHaveLength(1);
    await runDeletionCron(start + 24 * DAY);
    expect(mails.filter((m) => /Reminder/.test(m.subject))).toHaveLength(2);
    expect(await exists(ann.id)).toBe(true);

    const result = await runDeletionCron(start + 31 * DAY);
    expect(result).toMatchObject({ deletionLapsed: 1, accountsDeleted: 1 });
    expect(await exists(ann.id)).toBe(false);
    expect(mails.some((m) => m.to === bob.email && /Bet cancelled/.test(m.subject))).toBe(true);
    expect((await bob.a.get('/api/bets')).body).toEqual([]); // cancelled with a deleted user: nothing left to show
  });

  it("can be withdrawn, and asking again doesn't restart the clock", async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);
    const created = (await db.execute({ sql: 'SELECT created_at FROM bet_cancel_requests WHERE bet_id = ?', args: [id] })).rows[0].created_at;
    await requestDeletion(ann);
    expect((await db.execute({ sql: 'SELECT created_at FROM bet_cancel_requests WHERE bet_id = ?', args: [id] })).rows[0].created_at).toBe(created);

    await ann.a.delete('/api/me/deletion').expect(200);
    expect((await ann.a.get('/api/me')).body.deletionRequestedAt).toBeNull();
    expect((await bob.a.get('/api/me/cancel-requests')).body).toEqual([]);
    await ann.a.post('/api/bets').send({ opponentId: bob.id, question: 'More?', kind: 'number', guess: '1' }).expect(201);
  });

  it('a refusal answers one request only: the refuser deleting later asks again', async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    const id = await newBet(ann, bob);
    await requestDeletion(ann);
    await bob.a.post(`/api/bets/${id}/cancel-request/refuse`).expect(200);

    await requestDeletion(bob); // Bob wants out too: Ann is now asked
    const incoming = (await ann.a.get('/api/me/cancel-requests')).body;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ betId: id, from: { name: 'Bob' } });
    await ann.a.post(`/api/bets/${id}/cancel-request/accept`).expect(200);
    expect(await exists(ann.id)).toBe(false);
    expect(await exists(bob.id)).toBe(false);
  });
});

describe('export', () => {
  it("lists what we hold about the user, without anyone's secrets", async () => {
    const ann = await user('Ann');
    const bob = await user('Bob');
    await befriend(ann, bob);
    await settle(ann, bob, await newBet(ann, bob));
    const res = await ann.a.get('/api/me/export').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.profile.emails[0].email).toBe(ann.email);
    expect(res.body.friends).toHaveLength(1);
    expect(res.body.bets[0]).toMatchObject({ question: 'Goals?', with: 'Bob', iWon: true });
    expect(JSON.stringify({ ...res.body, invitationsSent: [] })).not.toContain(bob.email); // only the addresses she typed herself
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });
});
