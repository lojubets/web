import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mails: { to: string; text: string }[] = [];
vi.mock('./email.js', () => ({
  mailConfigured: () => true,
  sendMail: async (to: string, _subject: string, text: string) => (mails.push({ to, text }), true),
  sendInviteEmail: async () => false,
}));
import app from './app.js';
import { db } from './db.js';

// Every request comes from the same address, so start each test with fresh throttling counters.
beforeEach(async () => {
  await db.execute('DELETE FROM rate_limits').catch(() => undefined);
});

/** Registers with email/password and completes verification via the emailed link. */
const verifiedUser = async (email: string) => {
  const a = request.agent(app);
  await a.post('/api/auth/register').send({ email, password: 'correct horse' }).expect(201);
  const token = mails.filter((m) => m.to === email).at(-1)!.text.match(/token=([\w-]+)/)![1];
  await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
  return a;
};

const login = async (name: string) => {
  const a = request.agent(app);
  await a.post('/api/auth/dev').send({ name, email: `${name.toLowerCase()}@example.com` }).expect(200);
  return a;
};

describe('bets between friends', () => {
  let ann: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let annId: string;
  let bobId: string;

  beforeAll(async () => {
    ann = await login('Ann');
    bob = await login('Bob');
    annId = (await ann.get('/api/me')).body.id;
    bobId = (await bob.get('/api/me')).body.id;
  });

  it('rejects bets between strangers', async () => {
    await ann.post('/api/bets').send({ opponentId: bobId, question: 'Goals?', kind: 'number', guess: '2' }).expect(403);
  });

  it('connects via invitation token', async () => {
    const { body } = await ann.post('/api/invitations').send({ email: 'bob@example.com' }).expect(201);
    const token = body.link.split('/invite/')[1];
    await request(app).get(`/api/invitations/token/${token}`).expect(200);
    // Bob also sees it in his inbox, matched by verified email
    const inbox = await bob.get('/api/invitations');
    expect(inbox.body.received).toHaveLength(1);
    await bob.post(`/api/invitations/token/${token}/accept`).expect(200);
    expect((await ann.get('/api/friends')).body.map((f: any) => f.id)).toEqual([bobId]);
  });

  async function playBet(opts: { annGuess: string; bobGuess: string; outcome: string }) {
    const created = await ann.post('/api/bets').send({ opponentId: bobId, question: 'Barca goals?', kind: 'number', guess: opts.annGuess }).expect(201);
    const id = created.body.id;
    // creator's guess is hidden from the opponent until they answer
    expect((await bob.get(`/api/bets/${id}`)).body.theirGuess).toBeNull();
    await bob.post(`/api/bets/${id}/guess`).send({ guess: opts.bobGuess }).expect(200);
    return id as string;
  }

  async function settle(id: string, outcome: string) {
    await ann.post(`/api/bets/${id}/propose`).send({ outcome }).expect(200);
    await ann.post(`/api/bets/${id}/confirm`).expect(409); // can't confirm own proposal
    return bob.post(`/api/bets/${id}/confirm`).expect(200);
  }

  const balanceOnAnn = async () => (await ann.get('/api/friends')).body[0].balance as number;

  it('settles a bet: closer guess wins one lonkero', async () => {
    const id = await playBet({ annGuess: '2', bobGuess: '5', outcome: '3' });
    const { body } = await settle(id, '3');
    expect(body.winnerId).toBe(annId);
    expect(await balanceOnAnn()).toBe(1);
  });

  it('all-in: only the debtor, double or nothing', async () => {
    // Bob owes Ann 1 lonkero. Make it 3 by winning two more for Ann.
    for (let i = 0; i < 2; i++) await settle(await playBet({ annGuess: '2', bobGuess: '5', outcome: '3' }), '3');
    expect(await balanceOnAnn()).toBe(3);

    const id = await playBet({ annGuess: '2', bobGuess: '5', outcome: '3' });
    expect((await ann.get(`/api/bets/${id}`)).body.canAllIn).toBe(false); // Ann is in the black
    await ann.post(`/api/bets/${id}/all-in`).expect(409);
    const bobView = (await bob.get(`/api/bets/${id}`)).body;
    expect(bobView.canAllIn).toBe(true);
    expect(bobView.allInStake).toBe(3);
    await bob.post(`/api/bets/${id}/all-in`).expect(200);

    // Bob loses the all-in: owes 6
    await settle(id, '3');
    expect(await balanceOnAnn()).toBe(6);

    // Bob wins the next all-in: back to even
    const id2 = await playBet({ annGuess: '9', bobGuess: '3', outcome: '3' });
    await bob.post(`/api/bets/${id2}/all-in`).expect(200);
    await settle(id2, '3');
    expect(await balanceOnAnn()).toBe(0);
  });

  it('a rejected outcome returns the bet to active', async () => {
    const id = await playBet({ annGuess: '1', bobGuess: '2', outcome: '2' });
    await ann.post(`/api/bets/${id}/propose`).send({ outcome: '9' }).expect(200);
    const { body } = await bob.post(`/api/bets/${id}/reject`).expect(200);
    expect(body.status).toBe('active');
  });
});

describe('email/password accounts', () => {
  const creds = { email: 'Cy@Example.com', password: 'correct horse' };

  it('registers, signs in, and rejects bad credentials', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/register').send(creds).expect(201);
    await request(app).post('/api/auth/register').send(creds).expect(409);
    await request(app).post('/api/auth/register').send({ email: 'x@example.com', password: 'short' }).expect(400);

    const b = request.agent(app);
    await b.post('/api/auth/login').send({ email: 'cy@example.com', password: 'wrong password' }).expect(401);
    await b.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'correct horse' }).expect(401);
    await b.post('/api/auth/login').send({ email: 'cy@example.com', password: creds.password }).expect(200);
    expect((await b.get('/api/me')).body.email).toBe('cy@example.com');
  });

  it('has no display name at first: shown by email, until one is set', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/register').send({ email: 'Dot@Example.com', password: 'correct horse' }).expect(201);
    expect((await a.get('/api/me')).body).toMatchObject({ name: 'dot@example.com', profileName: '' });

    await a.put('/api/me').send({ name: 'Dot' }).expect(200);
    expect((await a.get('/api/me')).body).toMatchObject({ name: 'Dot', profileName: 'Dot' });

    await a.put('/api/me').send({ name: '   ' }).expect(200); // clearing goes back to the email
    expect((await a.get('/api/me')).body).toMatchObject({ name: 'dot@example.com', profileName: '' });
  });

  it('friends see a nameless user by their email', async () => {
    const inviter = await login('Pat');
    const nameless = await verifiedUser('nameless@example.com');
    const { body } = await inviter.post('/api/invitations').send({ email: 'nameless@example.com' });
    await nameless.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);
    expect((await inviter.get('/api/friends')).body[0]).toMatchObject({ name: 'nameless@example.com' });
    expect((await nameless.get('/api/friends')).body[0]).toMatchObject({ name: 'Pat' });
  });
});

describe('email verification', () => {
  const tokenFrom = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/token=([\w-]+)/)![1];

  it('verifies a password account, unlocking email-matched invitations', async () => {
    const inviter = await login('Dee');
    const eve = request.agent(app);
    await eve.post('/api/auth/register').send({ email: 'eve@example.com', password: 'hunter2hunter2' }).expect(201);
    expect((await eve.get('/api/me')).body.emailVerified).toBe(false);

    await inviter.post('/api/invitations').send({ email: 'eve@example.com' }).expect(201);
    await eve.get('/api/invitations').expect(403); // locked until verified

    const token = tokenFrom('eve@example.com'); // sent automatically at registration
    await eve.post('/api/me/verify-email').expect(429); // resend is throttled
    await request(app).post('/api/auth/verify-email').send({ token: 'bogus' }).expect(400);
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
    await request(app).post('/api/auth/verify-email').send({ token }).expect(400); // single use

    expect((await eve.get('/api/me')).body.emailVerified).toBe(true);
    expect((await eve.get('/api/invitations')).body.received).toHaveLength(1);
  });
});

describe('bet rules and tipping point', () => {
  const DAY = 86_400_000;
  let ann: ReturnType<typeof request.agent>;
  let bob: ReturnType<typeof request.agent>;
  let bobId: string;
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeAll(async () => {
    ann = await login('Fay');
    bob = await login('Gus');
    bobId = (await bob.get('/api/me')).body.id;
    const { body } = await ann.post('/api/invitations').send({ email: 'gus@example.com' });
    await bob.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);
  });

  afterEach(() => vi.useRealTimers());

  const create = (over: object) =>
    ann.post('/api/bets').send({ opponentId: bobId, question: 'When will it happen?', kind: 'instant', ...over });

  it('enforces numeric rules on both players\' guesses', async () => {
    const params = { integer: true, min: 0, max: 10, maxExclusive: true };
    await create({ kind: 'number', params, guess: '2.5' }).expect(400);
    await create({ kind: 'number', params, guess: '10' }).expect(400);
    const { body } = await create({ kind: 'number', params, guess: '4' }).expect(201);
    expect(body.params).toMatchObject(params);
    await bob.post(`/api/bets/${body.id}/guess`).send({ guess: '-1' }).expect(400);
    await bob.post(`/api/bets/${body.id}/guess`).send({ guess: '7' }).expect(200);
  });

  it('duration bets compare by closeness', async () => {
    const { body } = await create({ kind: 'duration', guess: '3:05' }).expect(201);
    expect(body.myGuess).toBe('11100');
    await bob.post(`/api/bets/${body.id}/guess`).send({ guess: '2 hours' }).expect(200);
    await ann.post(`/api/bets/${body.id}/propose`).send({ outcome: '3 hours' }).expect(200);
    const done = await bob.post(`/api/bets/${body.id}/confirm`).expect(200);
    expect(done.body.winnerId).not.toBe(bobId); // Fay (3:05) was closer to 3:00
  });

  it('rejects past times and short lead time for future-dated bets', async () => {
    const params = { precision: 'minute', allowPast: false, minLeadMinutes: 120 };
    await create({ params, guess: iso(Date.now() + 3_600_000) }).expect(400);
    await create({ params, guess: iso(Date.now() - DAY) }).expect(400);
    await create({ params, guess: iso(Date.now() + 3 * 3_600_000) }).expect(201);
  });

  async function futureBet(t0: number) {
    const params = { precision: 'minute', allowPast: false, minLeadMinutes: 0 };
    const { body } = await create({ params, guess: iso(t0 + 10 * DAY) }).expect(201);
    await bob.post(`/api/bets/${body.id}/guess`).send({ guess: iso(t0 + 20 * DAY) }).expect(200);
    return body.id as string;
  }

  it('reminds before the tipping point, then asks (rather than assumes) once it has passed', async () => {
    const t0 = Date.now();
    const id = await futureBet(t0);
    const active = (await ann.get(`/api/bets/${id}`)).body;
    expect(active).toMatchObject({ status: 'active', tippingSoon: false, tippingPassed: false });
    expect(active.tippingPoint).toBeGreaterThan(t0 + 15 * DAY);
    await ann.post(`/api/bets/${id}/not-happened`).expect(409); // too early to claim

    // ~1 day before the tipping point: reminders go out, once
    const before = mails.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 14.5 * DAY);
    expect((await request(app).get('/api/cron')).body.remindersSent).toBe(1);
    expect(mails.length - before).toBe(2);
    expect(mails.at(-1)!.text).toMatch(/Tipping point/);
    expect((await request(app).get('/api/cron')).body.remindersSent).toBe(0);
    expect((await ann.get(`/api/bets/${id}`)).body.tippingSoon).toBe(true);

    // After it: nothing is settled automatically; both are asked
    vi.setSystemTime(t0 + 16 * DAY);
    for (const who of [ann, bob]) {
      expect((await who.get(`/api/bets/${id}`)).body).toMatchObject({ status: 'active', tippingPassed: true, needsMyAction: true });
    }
    expect((await request(app).get('/api/cron')).body.passedNotices).toBe(1);
    expect(mails.at(-1)!.text).toMatch(/If the event happened, enter the result/);
    expect((await request(app).get('/api/cron')).body.passedNotices).toBe(0);
  });

  it("settles for the later guess only when both confirm the event hadn't happened", async () => {
    const t0 = Date.now();
    const id = await futureBet(t0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 16 * DAY);

    const proposed = (await ann.post(`/api/bets/${id}/not-happened`).expect(200)).body;
    expect(proposed).toMatchObject({ status: 'awaiting_confirmation', proposalKind: 'not_happened', outcomeProposedByMe: true });
    await ann.post(`/api/bets/${id}/confirm`).expect(409); // can't confirm your own claim
    const done = (await bob.post(`/api/bets/${id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ status: 'settled', settledBy: 'tipping_point', winnerId: bobId });
  });

  it('lets the other player dispute "not happened" and enter the real result instead', async () => {
    const t0 = Date.now();
    const id = await futureBet(t0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 16 * DAY);

    await ann.post(`/api/bets/${id}/not-happened`).expect(200);
    expect((await bob.post(`/api/bets/${id}/reject`).expect(200)).body.status).toBe('active');

    // It actually happened on day 11 (before the tipping point), so Fay's day-10 guess was closer
    await bob.post(`/api/bets/${id}/propose`).send({ outcome: iso(t0 + 11 * DAY) }).expect(200);
    const done = (await ann.post(`/api/bets/${id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ status: 'settled', settledBy: 'outcome' });
    expect(done.winnerId).not.toBe(bobId);
  });

  it('past-allowed bets have no tipping point', async () => {
    const { body } = await create({ params: { precision: 'day', allowPast: true }, guess: '2020-01-01' }).expect(201);
    await bob.post(`/api/bets/${body.id}/guess`).send({ guess: '2021-01-01' }).expect(200);
    expect((await ann.get(`/api/bets/${body.id}`)).body.tippingPoint).toBeNull();
  });
});

describe('guess secrecy', () => {
  it("nobody sees the other's guess, or anything derived from it, until both have locked in", async () => {
    const ann = await login('Hal');
    const bob = await login('Ivy');
    const bobId = (await bob.get('/api/me')).body.id;
    const annId = (await ann.get('/api/me')).body.id;
    const { body: inv } = await ann.post('/api/invitations').send({ email: 'ivy@example.com' });
    await bob.post(`/api/invitations/token/${inv.link.split('/invite/')[1]}/accept`).expect(200);

    const secret = '4242.5';
    const created = (await ann.post('/api/bets').send({ opponentId: bobId, question: 'Secret numbers', kind: 'number', guess: secret }).expect(201)).body;

    // Before Ivy locks in: she must not get Hal's guess from the detail or list endpoints, in any field
    for (const path of [`/api/bets/${created.id}`, '/api/bets', `/api/bets?with=${annId}`]) {
      const res = await bob.get(path).expect(200);
      if (path !== `/api/bets/${created.id}`) expect(res.body).toHaveLength(1); // the bet is really in the response
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    expect((await bob.get(`/api/bets/${created.id}`)).body).toMatchObject({ myGuess: null, theirGuess: null });
    // Hal sees only his own
    expect((await ann.get(`/api/bets/${created.id}`)).body).toMatchObject({ myGuess: secret, theirGuess: null });

    // Ivy can't change anything about Hal's guess, and a failed guess reveals nothing either
    const bad = await bob.post(`/api/bets/${created.id}/guess`).send({ guess: 'nope' }).expect(400);
    expect(JSON.stringify(bad.body)).not.toContain(secret);

    // Once both have locked in, both see both
    await bob.post(`/api/bets/${created.id}/guess`).send({ guess: '7' }).expect(200);
    expect((await bob.get(`/api/bets/${created.id}`)).body).toMatchObject({ myGuess: '7', theirGuess: secret });
    expect((await ann.get(`/api/bets/${created.id}`)).body).toMatchObject({ myGuess: secret, theirGuess: '7' });

    // A guess is final
    await bob.post(`/api/bets/${created.id}/guess`).send({ guess: '8' }).expect(409);
  });
});

describe('inviting requires a verified email', () => {
  it('is refused until the inviter verifies their address', async () => {
    const jo = request.agent(app);
    await jo.post('/api/auth/register').send({ email: 'jo@example.com', password: 'correct horse' }).expect(201);
    const refused = await jo.post('/api/invitations').send({ email: 'friend@example.com' }).expect(403);
    expect(refused.body.error).toMatch(/Verify your email/);
    await jo.get('/api/invitations').expect(403);

    const token = mails.filter((m) => m.to === 'jo@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1];
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200);
    await jo.post('/api/invitations').send({ email: 'friend@example.com' }).expect(201);
  });
});

describe('unverified accounts are locked to their profile', () => {
  it('can use /me and verification, but not friends, bets or invitations, until verified', async () => {
    const kim = request.agent(app);
    await kim.post('/api/auth/register').send({ email: 'kim@example.com', password: 'correct horse' }).expect(201);

    await kim.get('/api/me').expect(200);
    await kim.put('/api/me').send({ name: 'Kim' }).expect(200);
    for (const path of ['/api/friends', '/api/bets', '/api/invitations']) {
      const r = await kim.get(path).expect(403);
      expect(r.body.code).toBe('email_not_verified');
    }
    await kim.post('/api/bets').send({ opponentId: 'x', question: 'Nope', kind: 'number', guess: '1' }).expect(403);

    // accepting an invitation link needs a verified email too, but previewing it doesn't
    const host = await login('Lou');
    const { body } = await host.post('/api/invitations').send({ email: 'kim@example.com' });
    const token = body.link.split('/invite/')[1];
    await request(app).get(`/api/invitations/token/${token}`).expect(200);
    await kim.post(`/api/invitations/token/${token}/accept`).expect(403);

    const verify = mails.filter((m) => m.to === 'kim@example.com').at(-1)!.text.match(/token=([\w-]+)/)![1];
    await request(app).post('/api/auth/verify-email').send({ token: verify }).expect(200);
    await kim.get('/api/friends').expect(200);
    await kim.post(`/api/invitations/token/${token}/accept`).expect(200);
  });
});

describe('cancelling and calling a bet off', () => {
  let kai: ReturnType<typeof request.agent>;
  let lin: ReturnType<typeof request.agent>;
  let linId: string;

  beforeAll(async () => {
    kai = await login('Kai');
    lin = await login('Lin');
    linId = (await lin.get('/api/me')).body.id;
    const { body } = await kai.post('/api/invitations').send({ email: 'lin@example.com' });
    await lin.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);
  });

  const newBet = async (question = 'Goals?') =>
    (await kai.post('/api/bets').send({ opponentId: linId, question, kind: 'number', guess: '2' }).expect(201)).body.id as string;
  const activeBet = async (question?: string) => {
    const id = await newBet(question);
    await lin.post(`/api/bets/${id}/guess`).send({ guess: '5' }).expect(200);
    return id;
  };
  const balance = async () => (await kai.get('/api/friends')).body[0].balance as number;

  it('can be cancelled only until the other player has locked in a guess, by either player', async () => {
    const byCreator = await newBet();
    await kai.post(`/api/bets/${byCreator}/cancel`).expect(200);

    const declined = await newBet();
    await lin.post(`/api/bets/${declined}/cancel`).expect(200); // the opponent declining

    const locked = await activeBet();
    await kai.post(`/api/bets/${locked}/cancel`).expect(409);
    await lin.post(`/api/bets/${locked}/cancel`).expect(409);
  });

  it('cannot propose a tie before both have locked in', async () => {
    const id = await newBet();
    await kai.post(`/api/bets/${id}/propose-tie`).expect(409);
    await lin.post(`/api/bets/${id}/propose-tie`).expect(409);
  });

  it('is called off when both agree: no winner, and the bet stays in the history', async () => {
    const id = await activeBet();
    const proposed = (await kai.post(`/api/bets/${id}/propose-tie`).expect(200)).body;
    expect(proposed).toMatchObject({ status: 'awaiting_confirmation', proposalKind: 'tie', outcomeProposedByMe: true, needsMyAction: false });
    expect((await lin.get(`/api/bets/${id}`)).body).toMatchObject({ proposalKind: 'tie', outcomeProposedByMe: false, needsMyAction: true });

    await kai.post(`/api/bets/${id}/confirm`).expect(409); // can't agree with yourself
    const done = (await lin.post(`/api/bets/${id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ status: 'settled', settledBy: 'tie', winnerId: null, proposalKind: null });
    expect((await kai.get('/api/bets')).body.some((b: any) => b.id === id)).toBe(true);
  });

  it('either player can propose it, and the other can refuse, which puts the bet back in play', async () => {
    const id = await activeBet();
    await lin.post(`/api/bets/${id}/propose-tie`).expect(200);
    await lin.post(`/api/bets/${id}/reject`).expect(409); // the proposer can't reject their own
    const back = (await kai.post(`/api/bets/${id}/reject`).expect(200)).body;
    expect(back).toMatchObject({ status: 'active', proposalKind: null });

    // and it can be settled normally afterwards
    await kai.post(`/api/bets/${id}/propose`).send({ outcome: '2' }).expect(200);
    expect((await lin.post(`/api/bets/${id}/confirm`).expect(200)).body).toMatchObject({ settledBy: 'outcome', winnerId: expect.any(String) });
  });

  it('while a tie is pending, nobody can propose a result or another tie', async () => {
    const id = await activeBet();
    await kai.post(`/api/bets/${id}/propose-tie`).expect(200);
    await lin.post(`/api/bets/${id}/propose`).send({ outcome: '3' }).expect(409);
    await lin.post(`/api/bets/${id}/propose-tie`).expect(409);
    await kai.post(`/api/bets/${id}/propose-tie`).expect(409);
  });

  it('leaves balances alone, even for an all-in, and frees the all-in slot', async () => {
    // Lin owes Kai 1 lonkero
    const won = await activeBet();
    await kai.post(`/api/bets/${won}/propose`).send({ outcome: '2' }).expect(200);
    await lin.post(`/api/bets/${won}/confirm`).expect(200);
    const before = await balance();
    expect(before).toBeGreaterThan(0);

    const allIn = await activeBet();
    await lin.post(`/api/bets/${allIn}/all-in`).expect(200);
    const second = await activeBet('Second');
    expect((await lin.get(`/api/bets/${second}`)).body.canAllIn).toBe(false); // one all-in at a time

    await lin.post(`/api/bets/${allIn}/propose-tie`).expect(200);
    const done = (await kai.post(`/api/bets/${allIn}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ settledBy: 'tie', winnerId: null, allIn: true });
    expect(await balance()).toBe(before);
    expect((await lin.get(`/api/bets/${second}`)).body.canAllIn).toBe(true);
  });
});

describe('merging accounts', () => {
  type Agent = ReturnType<typeof request.agent>;
  const PW = 'correct horse';
  const id = async (a: Agent) => (await a.get('/api/me')).body.id as string;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  /** `inviter` invites `invitee` by email, who accepts: they are now friends. */
  async function befriend(inviter: Agent, invitee: Agent, inviteeEmail: string) {
    const { body } = await inviter.post('/api/invitations').send({ email: inviteeEmail }).expect(201);
    await invitee.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);
  }
  /** One settled bet; `creator` wins when `creatorWins`, otherwise the opponent does. */
  async function play(creator: Agent, opponent: Agent, creatorWins: boolean) {
    const oppId = await id(opponent);
    const bet = (await creator.post('/api/bets').send({ opponentId: oppId, question: 'Goals?', kind: 'number', guess: creatorWins ? '2' : '9' }).expect(201)).body.id;
    await opponent.post(`/api/bets/${bet}/guess`).send({ guess: creatorWins ? '9' : '2' }).expect(200);
    await creator.post(`/api/bets/${bet}/propose`).send({ outcome: '3' }).expect(200);
    await opponent.post(`/api/bets/${bet}/confirm`).expect(200);
    return bet as string;
  }
  const merge = (a: Agent, b: { email: string; password?: string }) =>
    a.post('/api/merge/password').send({ email: b.email, password: b.password ?? PW });

  it('moves everything to the signed-in account, keeps both emails, and every login works', async () => {
    const a = await login('Mia'); // dev login: mia@example.com, verified
    await a.put('/api/me').send({ name: 'Mia' }).expect(200);
    const b = await verifiedUser('mia.work@example.com'); // email/password, verified
    await b.put('/api/me').send({ name: 'Mia (work)' }).expect(200);
    await b.put('/api/me/avatar').send({ dataUrl: PNG }).expect(200);
    const cleo = await login('Cleo');

    // Both are friends with Cleo and have a settled bet with her: Cleo owes A one, B owes Cleo one
    await befriend(a, cleo, 'cleo@example.com');
    await befriend(b, cleo, 'cleo@example.com');
    await play(a, cleo, true);
    await play(cleo, b, true);
    // A and B are also friends with a settled bet between them
    await befriend(a, b, 'mia.work@example.com');
    await play(a, b, true);

    const aId = await id(a);
    await merge(a, { email: 'mia.work@example.com' }).expect(200);
    const preview = (await a.get('/api/merge/preview').expect(200)).body;
    expect(preview.blockers).toEqual([]);
    expect(preview.betsBetween).toBe(1);
    expect(preview.a).toMatchObject({ id: aId, profileName: 'Mia', primaryEmail: 'mia@example.com', friends: 2 });
    expect(preview.b).toMatchObject({ profileName: 'Mia (work)', primaryEmail: 'mia.work@example.com', hasAvatar: true });
    await a.get('/api/merge/avatar/b').expect(200).expect('Content-Type', /image\/png/);

    await a.post('/api/merge/confirm').send({ email: 'b', name: 'b', photo: 'b' }).expect(200);

    // The signed-in account survives, wearing B's email, name and photo, with both addresses on record
    const me = (await a.get('/api/me').expect(200)).body;
    expect(me).toMatchObject({ id: aId, email: 'mia.work@example.com', profileName: 'Mia (work)', hasAvatar: true, emailVerified: true });
    expect(me.emails).toEqual([
      { email: 'mia.work@example.com', verified: true, primary: true, signsInWithPassword: true, removeBlocked: null },
      { email: 'mia@example.com', verified: true, primary: false, signsInWithPassword: false, removeBlocked: null },
    ]);

    // Friends and bets are combined: Cleo once, the two accounts' bets with her, and balances add up (+1 -1)
    const friends = (await a.get('/api/friends')).body;
    expect(friends).toHaveLength(1);
    expect(friends[0]).toMatchObject({ name: 'Cleo', balance: 0 });
    expect((await a.get('/api/bets')).body).toHaveLength(2); // the bet between A and B is gone

    // The old account's session is dead, but both of its logins now sign in to the merged account
    await b.get('/api/me').expect(401);
    const viaPassword = request.agent(app);
    await viaPassword.post('/api/auth/login').send({ email: 'mia.work@example.com', password: PW }).expect(200);
    expect(await id(viaPassword)).toBe(aId);
    const viaDev = request.agent(app);
    await viaDev.post('/api/auth/dev').send({ name: 'Mia', email: 'mia@example.com' }).expect(200);
    expect(await id(viaDev)).toBe(aId);
    // the merge ticket was single use
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(404);
  });

  it('can keep the other choices: A\'s email, name and no photo; the other address stays as a secondary', async () => {
    const a = await login('Noa');
    await a.put('/api/me').send({ name: 'Noa' }).expect(200);
    await a.put('/api/me/avatar').send({ dataUrl: PNG }).expect(200);
    const b = await login('Noab'); // another dev login = another account
    await b.put('/api/me').send({ name: 'Noa Two' }).expect(200);

    await a.post('/api/merge/dev').send({ email: 'noab@example.com' }).expect(200);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(200);

    const me = (await a.get('/api/me')).body;
    expect(me).toMatchObject({ email: 'noa@example.com', profileName: 'Noa', hasAvatar: false });
    expect(me.emails.map((e: any) => [e.email, e.primary])).toEqual([['noa@example.com', true], ['noab@example.com', false]]);

    // An invitation to the secondary address reaches the merged account
    const inviter = await login('Ivo');
    await inviter.post('/api/invitations').send({ email: 'noab@example.com' }).expect(201);
    const received = (await a.get('/api/invitations')).body.received;
    expect(received).toHaveLength(1);
    // ...and the secondary address counts as the account's own (no inviting yourself)
    await a.post('/api/invitations').send({ email: 'noab@example.com' }).expect(400);
  });

  it('requires both emails to be verified, and says so', async () => {
    const a = await login('Pia');
    const unverified = request.agent(app);
    await unverified.post('/api/auth/register').send({ email: 'pia.old@example.com', password: PW }).expect(201);

    await merge(a, { email: 'pia.old@example.com' }).expect(200);
    const preview = (await a.get('/api/merge/preview').expect(200)).body;
    expect(preview.blockers.join(' ')).toMatch(/isn't verified/);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(409);
    // nothing moved
    expect(await id(unverified)).toBeTruthy();
  });

  it('refuses while the two accounts have an unfinished bet with each other', async () => {
    const a = await login('Rex');
    const b = await verifiedUser('rex.alt@example.com');
    await befriend(a, b, 'rex.alt@example.com');
    const bId = await id(b);
    await a.post('/api/bets').send({ opponentId: bId, question: 'Between us', kind: 'number', guess: '1' }).expect(201);

    await merge(a, { email: 'rex.alt@example.com' }).expect(200);
    const preview = (await a.get('/api/merge/preview').expect(200)).body;
    expect(preview.blockers.join(' ')).toMatch(/unfinished bet/);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(409);
  });

  it('only works with a real second login, not your own and not a wrong password', async () => {
    const a = await verifiedUser('sam@example.com');
    await merge(a, { email: 'sam@example.com' }).expect(400); // that's you
    await merge(a, { email: 'sam@example.com', password: 'wrong password' }).expect(401);
    await merge(a, { email: 'nobody@example.com' }).expect(401);
    await a.get('/api/merge/preview').expect(404); // no ticket was issued
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(404);
    await request(app).get('/api/merge/preview').expect(401); // signed in is required
  });

  it('a ticket only works for the account it was issued to', async () => {
    const a = await verifiedUser('una@example.com');
    const b = await verifiedUser('una.alt@example.com');
    const cookies = (res: { headers: Record<string, any> }) => (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]);

    const ticket = cookies(await merge(a, { email: 'una.alt@example.com' }).expect(200));
    const intruder = cookies(await request(app).post('/api/auth/dev').send({ name: 'Uma', email: 'uma@example.com' }).expect(200));
    const stolen = [...intruder, ...ticket.filter((c) => c.startsWith('merge='))];

    await request(app).get('/api/merge/preview').set('Cookie', stolen).expect(404);
    await request(app).post('/api/merge/confirm').set('Cookie', stolen).send({ email: 'a', name: 'a', photo: 'none' }).expect(404);
    expect(await id(b)).toBeTruthy(); // still its own account
  });

  it('can be cancelled before confirming', async () => {
    const a = await login('Tia');
    const b = await login('Tiab');
    await a.post('/api/merge/dev').send({ email: 'tiab@example.com' }).expect(200);
    await a.get('/api/merge/preview').expect(200);
    await a.delete('/api/merge').expect(200);
    await a.get('/api/merge/preview').expect(404);
    expect(await id(b)).toBeTruthy(); // untouched
  });
});

describe('passwords when merging', () => {
  type Agent = ReturnType<typeof request.agent>;
  const PW = 'correct horse';
  const NEW_PW = 'a brand new password';
  const id = async (a: Agent) => (await a.get('/api/me')).body.id as string;
  const startMerge = (a: Agent, email: string) => a.post('/api/merge/password').send({ email, password: PW });
  const confirm = (a: Agent, extra: object = {}) => a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none', ...extra });
  const canLogin = async (email: string, password: string) => (await request(app).post('/api/auth/login').send({ email, password })).status === 200;

  it('two password accounts need one new password, which works with both email addresses', async () => {
    const a = await verifiedUser('pw.one@example.com');
    await verifiedUser('pw.two@example.com');
    const aId = await id(a);

    await startMerge(a, 'pw.two@example.com').expect(200);
    expect((await a.get('/api/merge/preview').expect(200)).body.needsNewPassword).toBe(true);

    // a new password is required, and it has to be a real one
    await confirm(a).expect(400);
    await confirm(a, { newPassword: 'short' }).expect(400);
    await confirm(a, { newPassword: NEW_PW }).expect(200);

    for (const email of ['pw.one@example.com', 'pw.two@example.com']) {
      const session = request.agent(app);
      await session.post('/api/auth/login').send({ email, password: NEW_PW }).expect(200);
      expect(await id(session)).toBe(aId);
      expect(await canLogin(email, PW)).toBe(false); // neither old password works any more
    }
    expect((await a.get('/api/me')).body.emails.map((e: any) => e.signsInWithPassword)).toEqual([true, true]);
  });

  it('keeps the existing password when only one of the accounts has one', async () => {
    const a = await verifiedUser('keep.pw@example.com');
    await login('Keepdev'); // a dev account: no password
    await a.post('/api/merge/dev').send({ email: 'keepdev@example.com' }).expect(200);
    expect((await a.get('/api/merge/preview').expect(200)).body.needsNewPassword).toBe(false);
    await confirm(a).expect(200); // no new password asked for
    expect(await canLogin('keep.pw@example.com', PW)).toBe(true);
  });
});

describe('removing email addresses', () => {
  type Agent = ReturnType<typeof request.agent>;
  const PW = 'correct horse';
  const id = async (a: Agent) => (await a.get('/api/me')).body.id as string;
  const emails = async (a: Agent) => (await a.get('/api/me')).body.emails as { email: string; primary: boolean; verified: boolean; removeBlocked: string | null; signsInWithPassword: boolean }[];
  const remove = (a: Agent, email: string) => a.delete(`/api/me/emails/${encodeURIComponent(email)}`);
  const addRaw = (userId: string, email: string, verified: boolean) =>
    db.execute({ sql: 'INSERT INTO user_emails (user_id, email, verified, created_at) VALUES (?, ?, ?, ?)', args: [userId, email, verified ? 1 : 0, Date.now() + 1] });
  const mergeInto = async (a: Agent, otherEmail: string, otherPassword?: string) => {
    if (otherPassword) await a.post('/api/merge/password').send({ email: otherEmail, password: otherPassword }).expect(200);
    else await a.post('/api/merge/dev').send({ email: otherEmail }).expect(200);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(200);
  };

  it('never removes the only verified address', async () => {
    const u = await verifiedUser('only@example.com');
    expect((await emails(u))[0].removeBlocked).toMatch(/only verified/);
    await remove(u, 'only@example.com').expect(409);
    await remove(u, 'nobody@example.com').expect(404);
    expect(await emails(u)).toHaveLength(1);
  });

  it('an account that has not verified anything cannot delete its address to dodge verification', async () => {
    const u = request.agent(app);
    await u.post('/api/auth/register').send({ email: 'dodge@example.com', password: PW }).expect(201);
    expect((await emails(u))[0].removeBlocked).toMatch(/Verify an email address first/);
    await remove(u, 'dodge@example.com').expect(409);
    await u.get('/api/friends').expect(403); // still locked
  });

  it("removing a secondary address also removes the password login that used it, and frees the address", async () => {
    const a = await login('Ola');
    await verifiedUser('ola.work@example.com');
    await mergeInto(a, 'ola.work@example.com', PW); // keeps Ola's email; the work address becomes a password login on the account
    const work = (await emails(a)).find((e) => e.email === 'ola.work@example.com')!;
    expect(work).toMatchObject({ primary: false, signsInWithPassword: true, removeBlocked: null });

    await remove(a, 'ola.work@example.com').expect(200);
    expect((await emails(a)).map((e) => e.email)).toEqual(['ola@example.com']);
    expect((await request(app).post('/api/auth/login').send({ email: 'ola.work@example.com', password: PW })).status).toBe(401);
    // the address is free again for anyone to register
    await request(app).post('/api/auth/register').send({ email: 'ola.work@example.com', password: PW }).expect(201);
    // and the last verified address is now protected
    await remove(a, 'ola@example.com').expect(409);
  });

  it('removing the primary promotes the other verified address; provider logins are unaffected', async () => {
    const a = await login('Pam');
    await login('Pamb');
    await mergeInto(a, 'pamb@example.com');
    const before = await id(a);

    await remove(a, 'pam@example.com').expect(200);
    const me = (await a.get('/api/me')).body;
    expect(me).toMatchObject({ email: 'pamb@example.com', emailVerified: true });
    expect(me.emails).toHaveLength(1);
    expect(me.emails[0]).toMatchObject({ email: 'pamb@example.com', primary: true });
    // a sign-in through the provider doesn't depend on the address staying on the profile
    const again = request.agent(app);
    await again.post('/api/auth/dev').send({ name: 'Pam', email: 'pam@example.com' }).expect(200);
    expect(await id(again)).toBe(before);
  });

  it('an unverified extra address can be removed', async () => {
    const u = await verifiedUser('extra@example.com');
    await addRaw(await id(u), 'extra.unverified@example.com', false);
    expect((await emails(u)).find((e) => e.email === 'extra.unverified@example.com')).toMatchObject({ verified: false, removeBlocked: null });
    await remove(u, 'extra.unverified@example.com').expect(200);
    expect((await emails(u)).map((e) => e.email)).toEqual(['extra@example.com']);
  });

  it("never removes the address that is the account's only way to sign in", async () => {
    const u = await verifiedUser('onlylogin@example.com');
    await addRaw(await id(u), 'spare@example.com', true); // a verified address with no login of its own
    expect((await emails(u)).find((e) => e.email === 'onlylogin@example.com')!.removeBlocked).toMatch(/only way to sign in/);
    await remove(u, 'onlylogin@example.com').expect(409);
    await remove(u, 'spare@example.com').expect(200);
  });
});

describe('choosing the primary address', () => {
  type Agent = ReturnType<typeof request.agent>;
  const PW = 'correct horse';
  const id = async (a: Agent) => (await a.get('/api/me')).body.id as string;
  const primary = (a: Agent, email: string) => a.post(`/api/me/emails/${encodeURIComponent(email)}/primary`);

  it('makes a verified secondary address the primary one, and friends see it when there is no display name', async () => {
    const a = await verifiedUser('pm.one@example.com'); // no display name set
    await verifiedUser('pm.two@example.com');
    const friend = await login('Pmc');
    const { body } = await a.post('/api/invitations').send({ email: 'pmc@example.com' });
    await friend.post(`/api/invitations/token/${body.link.split('/invite/')[1]}/accept`).expect(200);

    await a.post('/api/merge/password').send({ email: 'pm.two@example.com', password: PW }).expect(200);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none', newPassword: 'a brand new password' }).expect(200);
    expect((await friend.get('/api/friends')).body[0].name).toBe('pm.one@example.com');

    await primary(a, 'pm.two@example.com').expect(200);
    const me = (await a.get('/api/me')).body;
    expect(me).toMatchObject({ email: 'pm.two@example.com', emailVerified: true });
    expect(me.emails.map((e: any) => [e.email, e.primary])).toEqual([['pm.two@example.com', true], ['pm.one@example.com', false]]);
    expect((await friend.get('/api/friends')).body[0].name).toBe('pm.two@example.com');

    // making the current primary primary again changes nothing; the old one can now be removed
    await primary(a, 'pm.two@example.com').expect(200);
    await a.delete(`/api/me/emails/${encodeURIComponent('pm.one@example.com')}`).expect(200);
  });

  it('refuses an unverified or unknown address, so the account can never be locked out by it', async () => {
    const u = await verifiedUser('pm.solo@example.com');
    await db.execute({ sql: 'INSERT INTO user_emails (user_id, email, verified, created_at) VALUES (?, ?, 0, ?)', args: [await id(u), 'pm.unverified@example.com', Date.now() + 1] });
    const res = await primary(u, 'pm.unverified@example.com').expect(409);
    expect(res.body.error).toMatch(/Verify this address/);
    await primary(u, 'nobody@example.com').expect(404);
    expect((await u.get('/api/me')).body).toMatchObject({ email: 'pm.solo@example.com', emailVerified: true });
    await u.get('/api/friends').expect(200); // still unlocked
  });
});

describe('session security', () => {
  const cookieOf = (res: { headers: Record<string, any> }) => (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('session='))!.split(';')[0];

  it('signs out every session on "sign out everywhere", keeping the calling browser signed in', async () => {
    const first = await login('Sess');
    const second = await login('Sess');
    await first.get('/api/me').expect(200);
    await first.post('/api/auth/logout-everywhere').expect(200);
    await first.get('/api/me').expect(200);
    await second.get('/api/me').expect(401);
  });

  it('does not accept another kind of token as a session', async () => {
    const a = request.agent(app);
    const r = await a.post('/api/auth/dev').send({ name: 'Typ', email: 'typ@example.com' }).expect(200);
    const forged = r.headers['set-cookie'] as unknown as string[];
    expect(forged.some((c) => c.startsWith('session='))).toBe(true);
    // a merge ticket is signed with the same key but must not work as a session
    const m = await a.post('/api/merge/dev').send({ email: 'sess@example.com' }).expect(200);
    const ticket = (m.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('merge='))!.split(';')[0].replace('merge=', 'session=');
    await request(app).get('/api/me').set('Cookie', ticket).expect(401);
  });

  it('renews an old session and enforces the absolute maximum', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode('test-secret');
    const id = (await (await login('Renew')).get('/api/me')).body.id as string;
    const token = (iat: number, auth: number) =>
      new SignJWT({ typ: 'session', ver: 0, auth }).setProtectedHeader({ alg: 'HS256' }).setSubject(id).setIssuedAt(iat).setExpirationTime(Math.floor(Date.now() / 1000) + 3600).sign(key);
    const now = Math.floor(Date.now() / 1000);
    const stale = await request(app).get('/api/me').set('Cookie', `session=${await token(now - 2 * 86_400, now - 2 * 86_400)}`).expect(200);
    expect(cookieOf(stale)).toMatch(/^session=/); // re-issued
    const fresh = await request(app).get('/api/me').set('Cookie', `session=${await token(now, now)}`).expect(200);
    expect(fresh.headers['set-cookie']).toBeUndefined();
    await request(app).get('/api/me').set('Cookie', `session=${await token(now, now - 181 * 86_400)}`).expect(401);
  });

  it('refuses cross-site state changes but allows same-origin ones', async () => {
    const a = await login('Csrf');
    await a.post('/api/auth/logout-everywhere').set('Origin', 'https://evil.example').expect(403);
    await a.post('/api/auth/logout-everywhere').set('Sec-Fetch-Site', 'cross-site').expect(403);
    await a.post('/api/auth/logout-everywhere').set('Origin', 'http://127.0.0.1').set('Host', '127.0.0.1').expect(200);
  });

  it('only offers the dev login to localhost', async () => {
    await request(app).post('/api/auth/dev').set('Host', 'bets.example.com').send({ name: 'X', email: 'x@example.com' }).expect(404);
  });

  it('throttles repeated password guesses for one email', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post('/api/auth/login').send({ email: 'victim@example.com', password: 'wrong password' })).status;
    expect(last).toBe(429);
  });
});

describe('public config', () => {
  it('leaves the privacy contact address out until PRIVACY_CONTACT_EMAIL is set', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.privacyContactEmail).toBeNull();
  });
});

describe('login methods on the profile', () => {
  type Agent = ReturnType<typeof request.agent>;
  type Login = { provider: string; subject: string; label: string; email: string | null; removeBlocked: string | null };
  const logins = async (a: Agent) => (await a.get('/api/me')).body.logins as Login[];
  const del = (a: Agent, l: { provider: string; subject: string }) => a.delete(`/api/me/logins/${l.provider}/${encodeURIComponent(l.subject)}`);

  /** An account with a development login (standing in for Google) and an emailed-and-verified password login. */
  const twoLogins = async (name: string) => {
    const a = await login(name);
    const pwEmail = `${name.toLowerCase()}.pw@example.com`;
    await verifiedUser(pwEmail);
    await a.post('/api/merge/password').send({ email: pwEmail, password: 'correct horse' }).expect(200);
    await a.post('/api/merge/confirm').send({ email: 'a', name: 'a', photo: 'none' }).expect(200);
    return { a, pwEmail };
  };

  it('lists a single login, which cannot be removed', async () => {
    const u = await verifiedUser('single.login@example.com');
    const l = await logins(u);
    expect(l).toMatchObject([{ provider: 'password', label: 'Email and password', email: 'single.login@example.com' }]);
    expect(l[0].removeBlocked).toBeTruthy();
    await del(u, l[0]).expect(409);
    expect(await logins(u)).toHaveLength(1);
  });

  it('lists both logins of a merged account and lets either one go, but never the last', async () => {
    const { a, pwEmail } = await twoLogins('Lena');
    const both = await logins(a);
    expect(both.map((l) => l.provider).sort()).toEqual(['dev', 'password']);
    expect(both.every((l) => l.removeBlocked === null)).toBe(true);

    await del(a, both.find((l) => l.provider === 'password')!).expect(200);
    const left = await logins(a);
    expect(left.map((l) => l.provider)).toEqual(['dev']);
    expect(left[0].removeBlocked).toBeTruthy();
    await del(a, left[0]).expect(409);
    // the password no longer works, but the address is still on the account
    await request(app).post('/api/auth/login').send({ email: pwEmail, password: 'correct horse' }).expect(401);
    expect(((await a.get('/api/me')).body.emails as { email: string }[]).map((e) => e.email)).toContain(pwEmail);
  });

  it('can remove the other login instead', async () => {
    const { a, pwEmail } = await twoLogins('Lars');
    await del(a, (await logins(a)).find((l) => l.provider === 'dev')!).expect(200);
    expect((await logins(a)).map((l) => l.provider)).toEqual(['password']);
    await request(app).post('/api/auth/login').send({ email: pwEmail, password: 'correct horse' }).expect(200);
  });

  it('does not remove logins that are not yours', async () => {
    const { a } = await twoLogins('Liisa');
    const other = await verifiedUser('someone.else@example.com');
    await del(a, { provider: 'password', subject: 'someone.else@example.com' }).expect(404);
    expect(await logins(other)).toHaveLength(1);
  });
});

describe('changing the password', () => {
  const NEW = 'a brand new passphrase';
  const change = (a: ReturnType<typeof request.agent>, body: object) => a.post('/api/me/password').send(body);

  it('needs the current password, then switches to the new one and signs out other devices', async () => {
    const email = 'changer@example.com';
    const here = await verifiedUser(email);
    const elsewhere = request.agent(app);
    await elsewhere.post('/api/auth/login').send({ email, password: 'correct horse' }).expect(200);

    await change(here, { currentPassword: 'wrong one', newPassword: NEW }).expect(403);
    await change(here, { currentPassword: 'correct horse', newPassword: 'short' }).expect(400);
    await request(app).post('/api/auth/login').send({ email, password: 'correct horse' }).expect(200); // unchanged so far

    await change(here, { currentPassword: 'correct horse', newPassword: NEW }).expect(200);
    await here.get('/api/me').expect(200); // this browser stays signed in
    await elsewhere.get('/api/me').expect(401); // others don't
    await request(app).post('/api/auth/login').send({ email, password: 'correct horse' }).expect(401);
    await request(app).post('/api/auth/login').send({ email, password: NEW }).expect(200);
  });

  it('is refused without a session, and for accounts with no password login', async () => {
    await change(request.agent(app), { currentPassword: 'x', newPassword: NEW }).expect(401);
    const dev = await login('Nopass');
    await change(dev, { currentPassword: 'x', newPassword: NEW }).expect(400);
  });

  it('throttles repeated guesses at the current password', async () => {
    const u = await verifiedUser('guesser@example.com');
    for (let i = 0; i < 10; i++) await change(u, { currentPassword: `wrong ${i}`, newPassword: NEW }).expect(403);
    await change(u, { currentPassword: 'correct horse', newPassword: NEW }).expect(429);
  });
});
