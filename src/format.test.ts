import { describe, expect, it } from 'vitest';
import type { InstantParams, NumberParams } from '../shared/types';
import { balanceText, describeRules, gts, listNames, toLocalInput } from './format';

describe('gts', () => {
  it('pluralises Gin & Tonics', () => {
    expect(gts(0)).toBe('0 GTs');
    expect(gts(1)).toBe('1 GT');
    expect(gts(2)).toBe('2 GTs');
    expect(gts(13)).toBe('13 GTs');
  });
});

describe('listNames', () => {
  it('joins names the way a sentence would', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Ann'])).toBe('Ann');
    expect(listNames(['Ann', 'Bob'])).toBe('Ann and Bob');
    expect(listNames(['Ann', 'Bob', 'Cara'])).toBe('Ann, Bob and Cara');
    expect(listNames(['Ann', 'Bob', 'Cara', 'Dan'])).toBe('Ann, Bob, Cara and Dan');
  });
});

describe('balanceText', () => {
  it('reads from my side, with pronouns so it fits on one line whatever the name', () => {
    expect(balanceText(0)).toBe("You're even");
    expect(balanceText(1)).toBe('They owe you 1 GT');
    expect(balanceText(3)).toBe('They owe you 3 GTs');
    expect(balanceText(-1)).toBe('You owe them 1 GT');
    expect(balanceText(-2)).toBe('You owe them 2 GTs');
  });
});

describe('describeRules', () => {
  const num = (over: Partial<NumberParams> = {}): NumberParams => ({ integer: false, min: null, max: null, minExclusive: false, maxExclusive: false, ...over });
  const inst = (over: Partial<InstantParams> = {}): InstantParams => ({ precision: 'day', allowPast: false, minLeadMinutes: 0, ...over });

  it('describes the answer kinds that have no rules of their own', () => {
    expect(describeRules('text', {})).toEqual(['A few words, judged by you and your friend afterwards']);
    expect(describeRules('yesno', {})).toEqual(['Yes or no']);
    expect(describeRules('duration', {})).toEqual(['A duration, e.g. 3:05, 25 days or 3 months and 2 days']);
    expect(describeRules('choice', { options: ['quit', 'get fired'] })).toEqual(['One of: quit, get fired']);
  });

  it('spells out numeric rules, only mentioning bounds that exist', () => {
    expect(describeRules('number', num())).toEqual(['Whole or decimal numbers']);
    expect(describeRules('number', num({ integer: true }))).toEqual(['Whole numbers only']);
    expect(describeRules('number', num({ min: 0 }))).toEqual(['Whole or decimal numbers', 'at least 0']);
    expect(describeRules('number', num({ max: 10, maxExclusive: true }))).toEqual(['Whole or decimal numbers', 'less than 10']);
    expect(describeRules('number', num({ integer: true, min: 0, minExclusive: true, max: 10 }))).toEqual(['Whole numbers only', 'more than 0 and at most 10']);
  });

  it('spells out date rules: precision, the past, and lead time', () => {
    expect(describeRules('instant', inst())).toEqual(['A date', 'Future only']);
    expect(describeRules('instant', inst({ precision: 'minute', allowPast: true }))).toEqual(['A date and time', 'Past dates allowed']);
    expect(describeRules('instant', inst({ minLeadMinutes: 120 }))).toEqual(['A date', 'At least 2 hours in the future when guessing']);
    expect(describeRules('instant', inst({ minLeadMinutes: 1 }))).toEqual(['A date', 'At least 1 minute in the future when guessing']);
  });
});

describe('toLocalInput', () => {
  it("formats a moment for <input type='datetime-local'> in the viewer's own time zone, zero-padded", () => {
    // Built from local components, so the expectation holds in whatever zone the tests run
    const d = new Date(2027, 2, 5, 7, 8); // 5 Mar 2027 07:08 local time
    expect(toLocalInput(d.getTime())).toBe('2027-03-05T07:08');
    expect(toLocalInput(new Date(2027, 11, 31, 23, 59).getTime())).toBe('2027-12-31T23:59');
  });
});
