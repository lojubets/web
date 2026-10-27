import { describe, expect, it } from 'vitest';
import { describeReading, formatDurationLong, parseDuration, readDuration } from '../shared/duration.js';
import type { InstantParams, NumberParams } from '../shared/types.js';
import { publicUrlProblem } from './env.js';
import { balanceFor, buildParams, decide, normalizeAnswer, tippingPoint, tippingVerdict } from './betLogic.js';

const NOW = Date.parse('2027-03-01T12:00:00Z');
const num = (over: Partial<NumberParams> = {}): NumberParams => ({ integer: false, min: null, max: null, minExclusive: false, maxExclusive: false, ...over });
const inst = (over: Partial<InstantParams> = {}): InstantParams => ({ precision: 'minute', allowPast: false, minLeadMinutes: 0, ...over });
const guess = (kind: any, params: any, v: string, now = NOW) => normalizeAnswer(kind, params, v, { now, role: 'guess' });
const err = (r: { ok: boolean }) => (r.ok ? null : (r as any).error);

describe('numeric rules', () => {
  it('accepts whole or decimal numbers by default, incl. negatives and comma decimals', () => {
    expect(guess('number', num(), '145')).toEqual({ ok: true, value: '145' });
    expect(guess('number', num(), '2,534')).toEqual({ ok: true, value: '2.534' });
    expect(guess('number', num(), '-3')).toEqual({ ok: true, value: '-3' });
    expect(err(guess('number', num(), 'abc'))).toBeTruthy();
    expect(err(guess('number', num(), ''))).toBeTruthy();
  });
  it('whole numbers only', () => {
    expect(guess('number', num({ integer: true }), '123').ok).toBe(true);
    expect(err(guess('number', num({ integer: true }), '12.53'))).toBe('Must be a whole number');
  });
  it('inclusive and exclusive bounds', () => {
    const p = num({ min: 0, max: 10, maxExclusive: true });
    expect(guess('number', p, '0').ok).toBe(true);
    expect(guess('number', p, '9.99').ok).toBe(true);
    expect(err(guess('number', p, '10'))).toBe('Must be less than 10');
    expect(err(guess('number', p, '-1'))).toBe('Must be at least 0');
    expect(err(guess('number', num({ min: 0, minExclusive: true }), '0'))).toBe('Must be greater than 0');
  });
  it('does not apply rules to the real outcome', () => {
    expect(normalizeAnswer('number', num({ integer: true, max: 5 }), '7.5', { now: NOW, role: 'outcome' }).ok).toBe(true);
  });
  it('rejects rules that leave no possible answer', () => {
    expect(buildParams('number', { min: 5, max: 5 }).ok).toBe(false);
    expect(buildParams('number', { integer: true, min: 1, minExclusive: true, max: 2, maxExclusive: true }).ok).toBe(false);
    expect(buildParams('number', { integer: true, min: 1, max: 2 }).ok).toBe(true);
    expect(buildParams('number', { bogus: 1 }).ok).toBe(false);
  });
});

describe('durations', () => {
  it('parses colon and word forms', () => {
    expect(parseDuration('3:05')).toBe(3 * 3600 + 5 * 60);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('3 hours and 5 minutes')).toBe(11100);
    expect(parseDuration('3h 5m')).toBe(11100);
    expect(parseDuration('1.5 hours')).toBe(5400);
    expect(parseDuration('2 days, 4 hours')).toBe(2 * 86400 + 4 * 3600);
    expect(parseDuration('45 sec')).toBe(45);
  });
  it('parses long durations: days, weeks, months, years', () => {
    const DAY = 86400;
    expect(parseDuration('25 days')).toBe(25 * DAY);
    expect(parseDuration('25days')).toBe(25 * DAY);
    expect(parseDuration('12 weeks')).toBe(84 * DAY);
    expect(parseDuration('3 months and 2 days')).toBe(92 * DAY); // a month counts as 30 days
    expect(parseDuration('1 year')).toBe(365 * DAY);
    expect(parseDuration('1 year, 2 months and 3 weeks')).toBe((365 + 60 + 21) * DAY);
    expect(parseDuration('1.5 months')).toBe(45 * DAY);
    expect(parseDuration('2w 3d')).toBe(17 * DAY);
    expect(parseDuration('2mo')).toBe(60 * DAY);
  });
  it('keeps "m" as minutes, never months', () => {
    expect(parseDuration('3m')).toBe(180);
    expect(parseDuration('3 m')).toBe(180);
    expect(parseDuration('3 months')).toBe(3 * 30 * 86400);
  });
  it('rejects junk and bare numbers', () => {
    for (const bad of ['', '90', 'soon', '3:75', '3 parsecs', '5 minutes later', '150 years']) expect(parseDuration(bad)).toBeNull();
  });
  it('reads text back as spelled-out units, so mistakes are visible', () => {
    const say = (text: string) => describeReading(readDuration(text)!);
    expect(say('3m')).toEqual({ text: '3 minutes', total: null });
    expect(say('3 months')).toEqual({ text: '3 months', total: '90 days' });
    expect(say('1 month')).toEqual({ text: '1 month', total: '30 days' });
    expect(say('3 months and 2 days')).toEqual({ text: '3 months and 2 days', total: '92 days' });
    expect(say('12 weeks').total).toBe('84 days');
    expect(say('1.5 hours')).toEqual({ text: '1.5 hours', total: '1 hour 30 minutes' });
    expect(say('3:05')).toEqual({ text: '3 hours and 5 minutes', total: null });
    expect(say('1:02:03').text).toBe('1 hour, 2 minutes and 3 seconds');
    expect(say('0:30').text).toBe('30 minutes');
    expect(say('1 year, 2 months and 3 weeks').text).toBe('1 year, 2 months and 3 weeks');
  });
  it('flags a bare "m" (minutes) but not months, mo or min', () => {
    expect(readDuration('3m')!.bareM).toBe(true);
    expect(readDuration('1h 30m')!.bareM).toBe(true);
    for (const ok of ['3 months', '3mo', '3 min', '3 minutes', '3:05', '25 days']) expect(readDuration(ok)!.bareM).toBe(false);
    expect(readDuration('soon')).toBeNull();
  });
  it('spells durations out in full for display', () => {
    expect(formatDurationLong(11100)).toBe('3 hours 5 minutes');
    expect(formatDurationLong(92 * 86400)).toBe('92 days');
    expect(formatDurationLong(86400 + 3600)).toBe('1 day 1 hour');
    expect(formatDurationLong(0)).toBe('0 minutes');
  });
  it('is normalised to seconds and compared by distance', () => {
    expect(guess('duration', {}, '3:05')).toEqual({ ok: true, value: '11100' });
    expect(decide('duration', '7200', '12000', '11100')).toBe('opponent');
  });
});

describe('date and time rules', () => {
  it('minute precision stores UTC ISO and rejects the past', () => {
    expect(guess('instant', inst(), '2027-03-02T09:30:45Z')).toEqual({ ok: true, value: '2027-03-02T09:30:00.000Z' });
    expect(err(guess('instant', inst(), '2027-03-01T11:00:00Z'))).toMatch(/past/);
    expect(err(guess('instant', inst(), 'tomorrow'))).toBeTruthy();
  });
  it('allows the past when asked to', () => {
    expect(guess('instant', inst({ allowPast: true }), '1999-01-01T00:00:00Z').ok).toBe(true);
  });
  it('enforces a minimum lead time (now + 2 hours)', () => {
    const p = inst({ minLeadMinutes: 120 });
    expect(err(guess('instant', p, '2027-03-01T13:59:00Z'))).toBe('Guess a time at least 2 hours from now');
    expect(guess('instant', p, '2027-03-01T14:00:00Z').ok).toBe(true);
  });
  it('day precision: today is fine, yesterday is not', () => {
    const p = inst({ precision: 'day' });
    expect(guess('instant', p, '2027-03-01').ok).toBe(true);
    expect(err(guess('instant', p, '2027-02-28'))).toBeTruthy();
    expect(err(guess('instant', p, '2027-02-30'))).toBe('Enter a valid date');
  });
  it('lead time conflicts with allowing the past', () => {
    expect(buildParams('instant', { allowPast: true, minLeadMinutes: 60 }).ok).toBe(false);
  });
  it('outcomes cannot be in the future', () => {
    const out = (v: string) => normalizeAnswer('instant', inst(), v, { now: NOW, role: 'outcome' });
    expect(out('2027-03-01T11:59:00Z').ok).toBe(true);
    expect(out('2027-03-05T00:00:00Z').ok).toBe(false);
  });
});

describe('decide', () => {
  it('picks the closer number and draws on equal distance', () => {
    expect(decide('number', '2', '5', '3')).toBe('creator');
    expect(decide('number', '0', '4', '3')).toBe('opponent');
    expect(decide('number', '2', '4', '3')).toBe('draw');
    expect(decide('number', '0.1', '0.3', '0.2')).toBe('draw'); // float noise is not a win
  });
  it('picks the closer instant', () => {
    expect(decide('instant', '2027-01-01', '2027-03-05', '2027-02-01')).toBe('creator');
    expect(decide('instant', '2027-01-01', '2027-02-02', '2027-02-01')).toBe('opponent');
  });
});

describe('tipping point', () => {
  const p = inst();
  it('is the midpoint (plus a minute of slack) for future-dated bets', () => {
    const tp = tippingPoint('instant', p, '2027-03-10T00:00:00.000Z', '2027-03-20T00:00:00.000Z')!;
    expect(new Date(tp).toISOString()).toBe('2027-03-15T00:01:00.000Z');
  });
  it('is symmetric in who guessed first', () => {
    expect(tippingPoint('instant', p, '2027-03-20T00:00:00.000Z', '2027-03-10T00:00:00.000Z')).toBe(
      tippingPoint('instant', p, '2027-03-10T00:00:00.000Z', '2027-03-20T00:00:00.000Z'),
    );
  });
  it('day precision waits for the midpoint to be before today', () => {
    // Mar 10 and Mar 20 -> midpoint Mar 15 00:00; resolved from the start of Mar 16
    const tp = tippingPoint('instant', inst({ precision: 'day' }), '2027-03-10', '2027-03-20')!;
    expect(new Date(tp).toISOString()).toBe('2027-03-16T00:00:00.000Z');
  });
  it('does not exist when the event may already have happened, or for other kinds', () => {
    expect(tippingPoint('instant', inst({ allowPast: true }), '2027-03-10T00:00Z', '2027-03-20T00:00Z')).toBeNull();
    expect(tippingPoint('number', num(), '1', '2')).toBeNull();
  });
  it('the later guess is the winner, and it really is closer to every outcome after the tipping point', () => {
    expect(tippingVerdict('instant', '2027-03-10', '2027-03-20')).toBe('opponent');
    expect(tippingVerdict('instant', '2027-03-20', '2027-03-10')).toBe('creator');
    expect(tippingVerdict('instant', '2027-03-10', '2027-03-10')).toBe('draw');
    const tp = tippingPoint('instant', p, '2027-03-10T00:00:00.000Z', '2027-03-20T00:00:00.000Z')!;
    for (const days of [0, 1, 30, 3000]) {
      const outcome = new Date(tp + days * 86_400_000).toISOString();
      expect(decide('instant', '2027-03-10T00:00:00.000Z', '2027-03-20T00:00:00.000Z', outcome)).toBe('opponent');
    }
  });
});

describe('publicUrlProblem', () => {
  it('flags a localhost APP_URL in production only', () => {
    for (const url of ['http://localhost:5173', 'http://127.0.0.1:3000', 'https://localhost', 'http://[::1]:5173']) {
      expect(publicUrlProblem(url, true)).toMatch(/APP_URL is set to .* redirect to localhost/);
      expect(publicUrlProblem(url, false)).toBeNull(); // fine in development
    }
    expect(publicUrlProblem('https://web-lkoskela.vercel.app', true)).toBeNull();
    expect(publicUrlProblem('https://localhost.example.com', true)).toBeNull();
  });
});

describe('balanceFor', () => {
  it('sums stakes by winner and ignores draws', () => {
    expect(balanceFor('me', [{ winnerId: 'me', stake: 1 }, { winnerId: 'x', stake: 1 }, { winnerId: null, stake: 1 }])).toBe(0);
    expect(balanceFor('me', [{ winnerId: 'x', stake: 3 }])).toBe(-3);
  });
});
