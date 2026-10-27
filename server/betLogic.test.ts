import { describe, expect, it } from 'vitest';
import { balanceFor, decide, normalizeValue } from './betLogic.js';

describe('normalizeValue', () => {
  it('accepts numbers and dates, rejects junk', () => {
    expect(normalizeValue('number', ' 3 ')).toBe('3');
    expect(normalizeValue('number', 'abc')).toBeNull();
    expect(normalizeValue('number', '')).toBeNull();
    expect(normalizeValue('date', '2027-02-28')).toBe('2027-02-28');
    expect(normalizeValue('date', '2027-02-30')).toBeNull();
    expect(normalizeValue('date', 'tomorrow')).toBeNull();
  });
});

describe('decide', () => {
  it('picks the closer number', () => {
    expect(decide('number', '2', '5', '3')).toBe('creator');
    expect(decide('number', '0', '4', '3')).toBe('opponent');
  });
  it('is a draw at equal distance', () => {
    expect(decide('number', '2', '4', '3')).toBe('draw');
  });
  it('picks the closer date, either side of the outcome', () => {
    expect(decide('date', '2027-01-01', '2027-03-05', '2027-02-01')).toBe('creator');
    expect(decide('date', '2027-01-01', '2027-02-02', '2027-02-01')).toBe('opponent');
  });
});

describe('balanceFor', () => {
  it('sums stakes by winner and ignores draws', () => {
    expect(balanceFor('me', [{ winnerId: 'me', stake: 1 }, { winnerId: 'x', stake: 1 }, { winnerId: null, stake: 1 }])).toBe(0);
    expect(balanceFor('me', [{ winnerId: 'x', stake: 3 }])).toBe(-3);
  });
});
