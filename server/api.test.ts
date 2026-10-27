import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
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
