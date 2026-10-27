import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mails: { to: string; text: string }[] = [];
vi.mock('./email.js', () => ({
  mailConfigured: () => true,
  sendMail: async (to: string, _subject: string, text: string) => (mails.push({ to, text }), true),
  sendInviteEmail: async () => false,
}));
import app from './app.js';

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

  it('settles a bet: closer guess wins one beer', async () => {
    const id = await playBet({ annGuess: '2', bobGuess: '5', outcome: '3' });
    const { body } = await settle(id, '3');
    expect(body.winnerId).toBe(annId);
    expect(await balanceOnAnn()).toBe(1);
  });

  it('all-in: only the debtor, double or nothing', async () => {
    // Bob owes Ann 1 beer. Make it 3 by winning two more for Ann.
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
  const creds = { name: 'Cy', email: 'Cy@Example.com', password: 'correct horse' };

  it('registers, signs in, and rejects bad credentials', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/register').send(creds).expect(201);
    expect((await a.get('/api/me')).body.name).toBe('Cy');
    await request(app).post('/api/auth/register').send(creds).expect(409);
    await request(app).post('/api/auth/register').send({ ...creds, email: 'x@example.com', password: 'short' }).expect(400);

    const b = request.agent(app);
    await b.post('/api/auth/login').send({ email: 'cy@example.com', password: 'wrong password' }).expect(401);
    await b.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'correct horse' }).expect(401);
    await b.post('/api/auth/login').send({ email: 'cy@example.com', password: creds.password }).expect(200);
    expect((await b.get('/api/me')).body.name).toBe('Cy');
  });
});

describe('email verification', () => {
  const tokenFrom = (to: string) => mails.filter((m) => m.to === to).at(-1)!.text.match(/token=([\w-]+)/)![1];

  it('verifies a password account, unlocking email-matched invitations', async () => {
    const inviter = await login('Dee');
    const eve = request.agent(app);
    await eve.post('/api/auth/register').send({ name: 'Eve', email: 'eve@example.com', password: 'hunter2hunter2' }).expect(201);
    expect((await eve.get('/api/me')).body.emailVerified).toBe(false);

    await inviter.post('/api/invitations').send({ email: 'eve@example.com' }).expect(201);
    expect((await eve.get('/api/invitations')).body.received).toHaveLength(0); // unverified: not matched

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
