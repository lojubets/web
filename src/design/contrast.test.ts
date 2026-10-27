import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the pairing rules of docs/brand-guide.md (section 3.3) against the real tokens.css,
 * in both light and dark mode. If you change a color and a pairing stops being legal, this fails.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const [lightCss, darkCss] = css.split('@media (prefers-color-scheme: dark)');

const declarations = (src: string) => Object.fromEntries([...src.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const light = declarations(lightCss);
const dark = { ...light, ...declarations(darkCss) };

function resolve(map: Record<string, string>, token: string): string {
  let v = map[token];
  for (let i = 0; i < 10 && v?.startsWith('var('); i++) v = map[v.slice(4, -1).trim()];
  if (!v?.startsWith('#')) throw new Error(`${token} did not resolve to a hex color (${v})`);
  return v;
}

const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [foreground role, background role, minimum ratio, what it is]
const TEXT = 4.5; // WCAG AA for normal text
const UI = 3; // WCAG AA for UI components and graphics
const RULES: [string, string, number, string][] = [
  ['--text', '--surface-page', TEXT, 'body text on page'],
  ['--text', '--surface-card', TEXT, 'body text on cards'],
  ['--text', '--surface-tint', TEXT, 'body text on tinted panels'],
  ['--text-muted', '--surface-page', TEXT, 'secondary text on page'],
  ['--text-muted', '--surface-card', TEXT, 'secondary text on cards'],
  ['--text-muted', '--surface-tint', TEXT, 'secondary text on tinted panels'],
  ['--text-positive', '--surface-page', TEXT, 'green text on page'],
  ['--text-positive', '--surface-card', TEXT, 'green text on cards'],
  ['--text-danger', '--surface-page', TEXT, 'error text on page'],
  ['--text-danger', '--surface-card', TEXT, 'error text on cards'],
  ['--text-link', '--surface-page', TEXT, 'links on page'],
  ['--action-fg', '--action-bg', TEXT, 'primary button label'],
  ['--action-fg', '--action-bg-hover', TEXT, 'primary button label (hover)'],
  ['--action-fg', '--action-bg-pressed', TEXT, 'primary button label (pressed)'],
  ['--on-brand', '--surface-brand', TEXT, 'text on masthead/hero/tab bar'],
  ['--on-brand-muted', '--surface-brand', TEXT, 'muted text on masthead/hero/tab bar'],
  ['--accent-on-brand', '--surface-brand', TEXT, 'yellow on navy (wordmark, active tab)'],
  ['--positive-fg', '--positive-bg', TEXT, 'positive chip/banner'],
  ['--negative-fg', '--negative-bg', TEXT, 'owing marker/banner'],
  ['--danger-fg', '--danger-bg', TEXT, 'error banner'],
  ['--neutral-fg', '--neutral-bg', TEXT, 'neutral chip'],
  ['--avatar-fg', '--avatar-bg', TEXT, 'avatar initials'],
  ['--border-control', '--surface-card', UI, 'input borders on cards'],
  ['--border-control', '--surface-page', UI, 'input borders on page'],
  ['--action-border', '--surface-page', UI, 'button edge on page'],
  ['--action-border', '--surface-card', UI, 'button edge on cards'],
  ['--focus-ring', '--surface-page', UI, 'focus outline on page'],
  ['--focus-ring', '--surface-card', UI, 'focus outline on cards'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s mode pairings', (_mode, map) => {
  it.each(RULES)('%s on %s is at least %s:1 (%s)', (fg, bg, min) => {
    expect(ratio(resolve(map, fg), resolve(map, bg))).toBeGreaterThanOrEqual(min);
  });
});

describe('forbidden pairings really are forbidden', () => {
  const p = (t: string) => resolve(light, t);
  it('yellow is unusable as text or edge on light surfaces', () => {
    expect(ratio(p('--yellow-500'), '#ffffff')).toBeLessThan(UI);
    expect(ratio(p('--yellow-500'), p('--cream-50'))).toBeLessThan(UI);
  });
  it('white text on leaf green fails AA, so it is banned', () => {
    expect(ratio('#ffffff', p('--green-500'))).toBeLessThan(TEXT);
  });
  it('navy on leaf green only reaches large-text contrast', () => {
    const r = ratio(p('--navy-900'), p('--green-500'));
    expect(r).toBeGreaterThanOrEqual(UI);
    expect(r).toBeLessThan(TEXT);
  });
  it('bright green as small text on light surfaces fails; Leaf 700 passes', () => {
    expect(ratio(p('--green-500'), p('--surface-card'))).toBeLessThan(TEXT);
    expect(ratio(p('--green-700'), p('--surface-card'))).toBeGreaterThanOrEqual(TEXT);
  });
});

describe('the brand palette matches the brief', () => {
  it('uses the three official hex values', () => {
    expect(light['--yellow-500'].toLowerCase()).toBe('#fdd815');
    expect(light['--green-500'].toLowerCase()).toBe('#4d9942');
    expect(light['--navy-900'].toLowerCase()).toBe('#082754');
  });
});
