import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../shared/types';

type Cache = typeof import('./cache');
type Pending = { path: string; resolve: (body: unknown) => void; reject: (status: number) => void };
let pending: Pending[];
let stored: Map<string, string>;
let cache: Cache;

const user = (id: string) => ({ id, name: id }) as Me;

/** A fresh copy of the module, as after a page reload; localStorage (`stored`) survives it. */
async function reloadPage() {
  vi.resetModules();
  cache = await import('./cache');
  return cache;
}

const saved = () => JSON.parse(stored.get('lojubets:cache:v1') ?? 'null');

async function answer(path: string, body: unknown, force = false) {
  const done = cache.revalidate(path, force);
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
  cache.setCacheOwner(user('alice'));
});

afterEach(() => vi.unstubAllGlobals());

describe('cache', () => {
  it('stores what the server answered and tells subscribers', async () => {
    const seen = vi.fn();
    const unsubscribe = cache.subscribe('/friends', seen);
    await answer('/friends', [{ id: 'bob' }]);
    expect(cache.peek('/friends')).toEqual([{ id: 'bob' }]);
    expect(seen).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps showing the old data while a refresh is under way', async () => {
    await answer('/bets', ['old']);
    const second = cache.revalidate('/bets');
    expect(cache.peek('/bets')).toEqual(['old']);
    pending[1].resolve(['new']);
    await second;
    expect(cache.peek('/bets')).toEqual(['new']);
  });

  it('does not tell subscribers when the server answers the same as before', async () => {
    await answer('/friends', ['bob']);
    const seen = vi.fn();
    cache.subscribe('/friends', seen);
    await answer('/friends', ['bob']);
    expect(seen).not.toHaveBeenCalled();
  });

  it('shares a request already in flight', () => {
    cache.revalidate('/bets');
    cache.revalidate('/bets');
    expect(pending).toHaveLength(1);
  });

  it('after a forced reload, an older answer arriving late does not win', async () => {
    const before = cache.revalidate('/bets');
    const after = cache.revalidate('/bets', true);
    expect(pending).toHaveLength(2);
    pending[1].resolve(['after the change']);
    await after;
    pending[0].resolve(['before the change']);
    await before;
    expect(cache.peek('/bets')).toEqual(['after the change']);
  });

  it('keeps the data and adds the error when a refresh fails', async () => {
    await answer('/friends', ['bob']);
    const second = cache.revalidate('/friends');
    pending[1].reject(500);
    await second;
    expect(cache.getEntry('/friends')).toEqual({ data: ['bob'], error: 'failed 500' });
  });

  it('drops the data when the server says it is gone (404)', async () => {
    await answer('/merge/preview', { a: 1 });
    const second = cache.revalidate('/merge/preview');
    pending[1].reject(404);
    await second;
    expect(cache.getEntry('/merge/preview')).toEqual({ error: 'failed 404' });
  });

  it('refetches what open screens show when another user signs in', async () => {
    await answer('/bets', ['alice']);
    cache.subscribe('/bets', () => {});
    cache.setCacheOwner(user('carol'));
    expect(pending.map((p) => p.path)).toEqual(['/bets', '/bets']);
    pending[1].resolve(['carol']);
    await cache.revalidate('/bets');
    expect(cache.peek('/bets')).toEqual(['carol']);
  });

  it('does not refetch when the same user is confirmed again', async () => {
    await answer('/bets', ['alice']);
    cache.subscribe('/bets', () => {});
    cache.setCacheOwner(user('alice'));
    expect(pending).toHaveLength(1);
  });

  it('forgets everything when another user signs in, and ignores answers meant for the previous one', async () => {
    await answer('/friends', ['bob']);
    const late = cache.revalidate('/bets');
    cache.setCacheOwner(user('carol'));
    expect(cache.peek('/friends')).toBeUndefined();
    pending[1].resolve(["alice's bets"]);
    await late;
    expect(cache.peek('/bets')).toBeUndefined();
    expect(saved()).toEqual({ owner: 'carol', me: user('carol'), entries: {} });
  });
});

describe('cache in localStorage', () => {
  it('brings back the user, friends and bets after a reload', async () => {
    await answer('/friends', ['bob']);
    await answer('/bets', ['a bet']);
    await reloadPage();
    expect(cache.cachedMe()).toEqual(user('alice'));
    expect(cache.peek('/friends')).toEqual(['bob']);
    expect(cache.peek('/bets')).toEqual(['a bet']);
  });

  it('updates the stored copy when the server has something new', async () => {
    await answer('/bets', ['old']);
    await reloadPage();
    await answer('/bets', ['new']);
    expect(saved().entries['/bets']).toEqual(['new']);
    await reloadPage();
    expect(cache.peek('/bets')).toEqual(['new']);
  });

  it('keeps single bets and other responses in memory only', async () => {
    await answer('/bets/b1', { id: 'b1' });
    await answer('/config', {});
    expect(Object.keys(saved().entries)).toEqual([]);
  });

  it('is deleted on signing out', async () => {
    await answer('/friends', ['bob']);
    cache.clearCache();
    expect(stored.size).toBe(0);
    await reloadPage();
    expect(cache.cachedMe()).toBeUndefined();
    expect(cache.peek('/friends')).toBeUndefined();
  });

  it('still works in memory when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    await reloadPage();
    cache.setCacheOwner(user('alice'));
    await answer('/friends', ['bob']);
    expect(cache.peek('/friends')).toEqual(['bob']);
  });
});
