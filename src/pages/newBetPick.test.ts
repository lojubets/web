import { describe, expect, it } from 'vitest';
import { initialPick } from './newBetPick';

describe('initialPick', () => {
  it('ticks the only friend when there is just one', () => {
    expect(initialPick(['bob'], null)).toEqual(['bob']);
  });

  it('ticks nobody when there are several friends', () => {
    expect(initialPick(['bob', 'cara'], null)).toEqual([]);
    expect(initialPick(['bob', 'cara', 'dan'], null)).toEqual([]);
  });

  it('ticks nobody when there are no friends', () => {
    expect(initialPick([], null)).toEqual([]);
  });

  it('ticks the friend named in the link, however many friends there are', () => {
    expect(initialPick(['bob', 'cara'], 'cara')).toEqual(['cara']);
    expect(initialPick(['bob'], 'bob')).toEqual(['bob']);
  });

  it('ticks nobody when the friend named in the link is not available', () => {
    expect(initialPick(['bob', 'cara'], 'dan')).toEqual([]);
    expect(initialPick(['bob'], 'dan')).toEqual([]);
  });
});
