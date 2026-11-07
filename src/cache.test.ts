import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEntry, peek, revalidate, setCacheOwner, subscribe } from './cache';

type Pending = { path: string; resolve: (body: unknown) => void; reject: (status: number) => void };
let pending: Pending[];

beforeEach(() => {
  pending = [];
  vi.stubGlobal('fetch', (url: string) =>
    new Promise((ok) => {
      const path = url.replace(/^\/api/, '');
      pending.push({
        path,
        resolve: (body) => ok({ ok: true, status: 200, json: async () => body }),
        reject: (status) => ok({ ok: false, status, json: async () => ({ error: `failed ${status}` }) }),
      });
    }),
  );
  setCacheOwner('alice');
});

afterEach(() => {
  setCacheOwner(null);
  vi.unstubAllGlobals();
});

describe('cache', () => {
  it('stores what the server answered and tells subscribers', async () => {
    const seen = vi.fn();
    const unsubscribe = subscribe('/friends', seen);
    const done = revalidate('/friends');
    pending[0].resolve([{ id: 'bob' }]);
    await done;
    expect(peek('/friends')).toEqual([{ id: 'bob' }]);
    expect(seen).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps showing the old data while a refresh is under way', async () => {
    const first = revalidate('/bets');
    pending[0].resolve(['old']);
    await first;
    const second = revalidate('/bets');
    expect(peek('/bets')).toEqual(['old']);
    pending[1].resolve(['new']);
    await second;
    expect(peek('/bets')).toEqual(['new']);
  });

  it('shares a request already in flight', () => {
    revalidate('/bets');
    revalidate('/bets');
    expect(pending).toHaveLength(1);
  });

  it('after a forced reload, an older answer arriving late does not win', async () => {
    const before = revalidate('/bets');
    const after = revalidate('/bets', true);
    expect(pending).toHaveLength(2);
    pending[1].resolve(['after the change']);
    await after;
    pending[0].resolve(['before the change']);
    await before;
    expect(peek('/bets')).toEqual(['after the change']);
  });

  it('keeps the data and adds the error when a refresh fails', async () => {
    const first = revalidate('/friends');
    pending[0].resolve(['bob']);
    await first;
    const second = revalidate('/friends');
    pending[1].reject(500);
    await second;
    expect(getEntry('/friends')).toEqual({ data: ['bob'], error: 'failed 500' });
  });

  it("forgets everything when another user signs in, and ignores answers meant for the previous one", async () => {
    const first = revalidate('/friends');
    pending[0].resolve(['bob']);
    await first;
    const late = revalidate('/bets');
    setCacheOwner('carol');
    expect(peek('/friends')).toBeUndefined();
    pending[1].resolve(["alice's bets"]);
    await late;
    expect(peek('/bets')).toBeUndefined();
  });
});
