import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bet, Me, Participant } from '../shared/types';

type Store = typeof import('./store');
type Pending = { path: string; resolve: (body: unknown) => void; reject: (status: number) => void };
let pending: Pending[];
let stored: Map<string, string>;
let store: Store;

const user = (id: string) => ({ id, name: id }) as Me;
const person = (id: string, status: Participant['status'] = 'joined') => ({ id, name: id, status, isMe: id === 'alice' }) as Participant;
const bet = (id: string, extra: Partial<Bet> = {}) =>
  ({ id, question: `Q ${id}`, status: 'active', createdAt: Number(id.replace(/\D/g, '')) || 0, participants: [person('alice'), person('bob')], ...extra }) as Bet;

/** A fresh copy of the module, as after a page reload; localStorage (`stored`) survives it. */
async function reloadPage() {
  vi.resetModules();
  store = await import('./store');
}

const saved = () => JSON.parse(stored.get('lojubets:model:v1') ?? 'null');
const model = () => store.getState().model;
const myBets = () => model().betIds?.map((id) => model().bets[id].question);

/** Asks the server for `resource` and answers with `body`. */
async function answer(resource: Parameters<Store['refresh']>[0], body: unknown, force = false) {
  const done = store.refresh(resource, force);
  pending.at(-1)!.resolve(body);
  await done;
}

beforeEach(async () => {
  pending = [];
  stored = new Map();
  vi.stubGlobal('fetch', (url: string) =>
    new Promise((ok) => {
      pending.push({
        path: url.replace(/^\/api/, ''),
        resolve: (body) => ok({ ok: true, status: 200, json: async () => body }),
        reject: (status) => ok({ ok: false, status, json: async () => ({ error: `failed ${status}` }) }),
      });
    }),
  );
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  await reloadPage();
  store.setOwner(user('alice'));
});

afterEach(() => vi.unstubAllGlobals());

describe('the model', () => {
  it("holds the user's friends as the server listed them, and tells subscribers", async () => {
    const seen = vi.fn();
    store.subscribe(seen);
    await answer('friends', [{ id: 'bob' }]);
    expect(model().friends).toEqual([{ id: 'bob' }]);
    expect(pending[0].path).toBe('/friends');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('keeps what it knows while asking the server again', async () => {
    await answer('bets', [bet('b1')]);
    const again = store.refresh('bets');
    expect(myBets()).toEqual(['Q b1']);
    pending[1].resolve([bet('b2'), bet('b1')]);
    await again;
    expect(myBets()).toEqual(['Q b2', 'Q b1']);
  });

  it('does not tell subscribers when the server answers the same as before', async () => {
    await answer('friends', [{ id: 'bob' }]);
    const seen = vi.fn();
    store.subscribe(seen);
    await answer('friends', [{ id: 'bob' }]);
    expect(seen).not.toHaveBeenCalled();
  });

  it('keeps unchanged bets as the same objects, so screens showing them do not redraw', async () => {
    await answer('bets', [bet('b2'), bet('b1')]);
    const b1 = model().bets.b1;
    await answer('bets', [bet('b2', { question: 'changed' }), bet('b1')]);
    expect(model().bets.b1).toBe(b1);
  });

  it('a bet fetched on its own updates the same bet in the list', async () => {
    await answer('bets', [bet('b2'), bet('b1')]);
    await answer('bet:b1', bet('b1', { question: 'Q b1, now settled', status: 'settled' }));
    expect(pending[1].path).toBe('/bets/b1');
    expect(myBets()).toEqual(['Q b2', 'Q b1, now settled']);
  });

  it('a bet the user has left drops out of their list but can still be looked at', async () => {
    await answer('bets', [bet('b1')]);
    await answer('bet:b1', bet('b1', { participants: [person('alice', 'declined'), person('bob')] }));
    expect(myBets()).toEqual([]);
    expect(model().bets.b1).toBeDefined();
  });

  it('a bet the server returns after an action, or a new bet, joins the list in date order', async () => {
    await answer('bets', [bet('b3'), bet('b1')]);
    store.putBet(bet('b2'));
    store.putBet(bet('b4'));
    expect(myBets()).toEqual(['Q b4', 'Q b3', 'Q b2', 'Q b1']);
  });

  it('dropBet takes a bet the user left out of their list', async () => {
    await answer('bets', [bet('b1')]);
    store.dropBet('b1');
    expect(myBets()).toEqual([]);
  });

  it('a bet that is gone (404) leaves the model; other failures keep what is known', async () => {
    await answer('bets', [bet('b2'), bet('b1')]);
    const gone = store.refresh('bet:b1', true);
    pending[1].reject(404);
    await gone;
    expect(model().bets.b1).toBeUndefined();
    expect(myBets()).toEqual(['Q b2']);
    expect(store.getState().errors['bet:b1']).toBe('failed 404');

    const failing = store.refresh('bets', true);
    pending[2].reject(500);
    await failing;
    expect(myBets()).toEqual(['Q b2']);
    expect(store.getState().errors.bets).toBe('failed 500');
    await answer('bets', [bet('b2')], true);
    expect(store.getState().errors.bets).toBeUndefined();
  });

  it('shares a request already in flight', () => {
    store.refresh('bets');
    store.refresh('bets');
    expect(pending).toHaveLength(1);
  });

  it('after a forced refresh, an older answer arriving late does not win', async () => {
    const before = store.refresh('friends');
    const after = store.refresh('friends', true);
    pending[1].resolve(['after the change']);
    await after;
    pending[0].resolve(['before the change']);
    await before;
    expect(model().friends).toEqual(['after the change']);
  });

  it('forgets everything when another user signs in, ignores answers meant for the previous one, and refetches what is shown', async () => {
    await answer('friends', [{ id: 'bob' }]);
    store.show('friends');
    const late = store.refresh('bets');
    store.setOwner(user('carol'));
    expect(model()).toEqual({ me: user('carol'), bets: {} });
    expect(pending.at(-1)!.path).toBe('/friends'); // refetched for Carol
    pending[1].resolve([bet("alice's")]);
    await late;
    expect(model().betIds).toBeUndefined();
  });

  it('does not refetch when the same user is confirmed again', async () => {
    store.show('friends');
    store.setOwner(user('alice'));
    expect(pending).toHaveLength(0);
  });
});

describe('the model in localStorage', () => {
  it('brings back the user, friends, invitations and bets after a reload', async () => {
    await answer('friends', [{ id: 'bob' }]);
    await answer('invitations', { sent: [], received: [] });
    await answer('bets', [bet('b1')]);
    await reloadPage();
    expect(store.cachedMe()).toEqual(user('alice'));
    expect(model().friends).toEqual([{ id: 'bob' }]);
    expect(model().invitations).toEqual({ sent: [], received: [] });
    expect(myBets()).toEqual(['Q b1']);
  });

  it('is updated when the server has something new', async () => {
    await answer('bets', [bet('b1')]);
    await reloadPage();
    await answer('bet:b1', bet('b1', { question: 'new' }));
    expect(saved().model.bets.b1.question).toBe('new');
  });

  it("keeps bets the user has left in memory only", async () => {
    await answer('bets', []);
    await answer('bet:b9', bet('b9', { status: 'cancelled' }));
    expect(model().bets.b9).toBeDefined();
    expect(saved().model.bets).toEqual({});
  });

  it('is deleted on signing out, along with the old per-URL cache', async () => {
    stored.set('lojubets:cache:v1', '{}');
    await answer('friends', [{ id: 'bob' }]);
    store.clearStore();
    expect(stored.size).toBe(0);
    await reloadPage();
    expect(store.cachedMe()).toBeUndefined();
    expect(model().friends).toBeUndefined();
  });

  it('still works in memory when localStorage is unavailable', async () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    await reloadPage();
    store.setOwner(user('alice'));
    await answer('friends', [{ id: 'bob' }]);
    expect(model().friends).toEqual([{ id: 'bob' }]);
  });
});
