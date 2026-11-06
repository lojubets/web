// `npm run screenshots`: starts the API (throwaway database, dev login) and the web app on spare ports, drives them
// with headless Chromium through a few scenarios involving three users, and writes screenshots plus a gallery page to
// screenshots/index.html (open it straight from disk, no server needed).
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'screenshots');
const imagesDir = path.join(out, 'images');
const dataDir = path.join(out, '.data');
const API_PORT = Number(process.env.SCREENSHOTS_API_PORT ?? 3101);
const WEB_PORT = Number(process.env.SCREENSHOTS_WEB_PORT ?? 5273);
const base = `http://localhost:${WEB_PORT}`;

const VIEWPORTS = {
  mobile: { label: 'Mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { label: 'Desktop', viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
};

const USERS = {
  alice: { name: 'Alice Aaltonen', email: 'alice@example.com' },
  bob: { name: 'Bob Berg', email: 'bob@example.com' },
  cara: { name: 'Cara Cortez', email: 'cara@example.com' },
};

// ---------- servers ----------

const children = [];
function start(name, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${name} exited unexpectedly (${code}):\n${log}`);
      process.exit(1);
    }
  });
  children.push(child);
}

let stopping = false;
function stopServers() {
  stopping = true;
  for (const c of children) c.kill();
}
process.on('SIGINT', () => (stopServers(), process.exit(130)));
process.on('SIGTERM', () => (stopServers(), process.exit(143)));

async function waitFor(url, what) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what} at ${url}`);
}

// ---------- scenario plumbing ----------

// The API refuses writes that don't look same-site, and the dev proxy changes the Host an Origin header would be
// compared with, so vouch for these requests this way instead.
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' };
const shots = [];
const sessions = new Map();
let browser;

/** A browser context signed in as the given user (via the dev login), per viewport. Its `request` shares the cookies. */
async function session(user, vp = 'mobile') {
  const key = `${user}/${vp}`;
  if (!sessions.has(key)) {
    const v = VIEWPORTS[vp];
    const context = await browser.newContext({ baseURL: base, viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, isMobile: v.isMobile, hasTouch: v.hasTouch });
    if (user) {
      const res = await context.request.post('/api/auth/dev', { data: USERS[user], headers: SAME_ORIGIN });
      if (!res.ok()) throw new Error(`Dev login failed for ${user}: ${res.status()} ${await res.text()}. Is DEV_LOGIN on?`);
    }
    sessions.set(key, context);
  }
  return sessions.get(key);
}

/** Calls the API as a user and returns the parsed JSON. */
async function call(user, method, url, data) {
  const res = await (await session(user)).request.fetch(`/api${url}`, { method, data, headers: SAME_ORIGIN });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${user} ${method} ${url} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : null;
}

let n = 0;
/**
 * Takes screenshots of one screen at each viewport.
 * `as`: user key, or null for a signed-out visitor. `act` can click around before the picture is taken.
 */
async function shot({ group, title, note, as, url, viewports = ['mobile', 'desktop'], act, fullPage = true }) {
  const images = [];
  for (const vp of viewports) {
    const context = await session(as ?? null, vp);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.getByText('Loading…').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    if (act) await act(page);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
    // A full-page capture would leave the fixed tab bar floating mid-image; let it sit at the end of the page instead.
    await page.addStyleTag({ content: '.tabbar { position: static !important; }' });
    const file = `${String(++n).padStart(3, '0')}-${vp}.png`;
    await page.screenshot({ path: path.join(imagesDir, file), fullPage });
    await page.close();
    images.push({ vp, label: VIEWPORTS[vp].label, file: `images/${file}` });
  }
  shots.push({ group, title, note, as: as ? USERS[as].name : 'Signed out', url, images });
  console.log(`  ${group} › ${title}`);
}

// ---------- the scenarios ----------

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function scenarios() {
  const people = ['alice', 'bob', 'cara'];

  console.log('Signed-out screens');
  await shot({ group: 'Signed out', title: 'Sign in', note: 'With the dev login form.', as: null, url: '/login' });
  await shot({ group: 'Signed out', title: 'Forgot password', as: null, url: '/forgot-password' });
  await shot({ group: 'Signed out', title: 'Privacy policy', as: null, url: '/privacy' });
  await shot({ group: 'Signed out', title: 'Style guide', as: null, url: '/styleguide' });

  console.log('A new user with no friends');
  for (const p of people) await session(p); // signs everyone up
  await shot({ group: 'First steps', title: 'Bets, nothing yet', as: 'alice', url: '/' });
  await shot({ group: 'First steps', title: 'Friends, nothing yet', as: 'alice', url: '/friends' });
  await shot({ group: 'First steps', title: 'Profile', as: 'alice', url: '/profile' });
  await shot({ group: 'First steps', title: 'Merge accounts', as: 'alice', url: '/merge' });

  console.log('Inviting friends');
  const toBob = await call('alice', 'POST', '/invitations', { email: USERS.bob.email });
  const toCara = await call('alice', 'POST', '/invitations', { email: USERS.cara.email });
  const invitePath = (link) => new URL(link).pathname;
  await shot({ group: 'Invitations', title: 'Alice has invited two people', as: 'alice', url: '/friends' });
  await shot({ group: 'Invitations', title: 'Bob has a pending invitation', as: 'bob', url: '/friends' });
  await shot({ group: 'Invitations', title: 'Invite link, signed in', as: 'bob', url: invitePath(toBob.link) });
  await shot({ group: 'Invitations', title: 'Invite link, signed out', as: null, url: invitePath(toCara.link) });

  const { received } = await call('bob', 'GET', '/invitations');
  await call('bob', 'POST', `/invitations/${received[0].id}/accept`);
  await call('cara', 'POST', `/invitations/token/${toCara.link.split('/').pop()}/accept`);
  const myId = {}; // user ids, to name the opponent when creating a bet
  for (const p of people) myId[p] = (await call(p, 'GET', '/me')).id;

  await shot({ group: 'Friends', title: 'Friends list, no bets yet', as: 'alice', url: '/friends' });
  await shot({ group: 'Friends', title: 'A friend with no bets', as: 'alice', url: `/friends/${myId.bob}` });

  console.log('Creating a bet');
  await shot({ group: 'Creating a bet', title: 'New bet form', as: 'alice', url: '/bets/new' });
  for (const [kind, label] of [['Duration', 'A duration'], ['Date or time', 'A date or time'], ['Yes or no', 'Yes or no'], ['Multiple choice', 'Multiple choice'], ['Freeform', 'Freeform']]) {
    await shot({
      group: 'Creating a bet',
      title: `New bet: ${kind.toLowerCase()}`,
      as: 'alice',
      url: '/bets/new',
      act: async (page) => {
        await page.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
      },
    });
  }

  console.log('Setting up bets');
  const bet = (as, opponent, question, kind, params, guess) => call(as, 'POST', '/bets', { opponentId: myId[opponent], question, kind, params, guess });
  const guess = (as, b, g) => call(as, 'POST', `/bets/${b.id}/guess`, { guess: g });

  // Alice and Bob
  const settled = await bet('alice', 'bob', 'How long is the Finland–Sweden ice hockey final?', 'duration', {}, '2:15');
  await guess('bob', settled, '3 hours');
  await call('alice', 'POST', `/bets/${settled.id}/propose`, { outcome: '2:30' });
  await call('bob', 'POST', `/bets/${settled.id}/confirm`);

  const yesno = await bet('alice', 'bob', "Will Kane win the Ballon d'Or?", 'yesno', {}, 'yes');
  await guess('bob', yesno, 'no');
  await call('bob', 'POST', `/bets/${yesno.id}/all-in`); // Bob lost the first bet, so he's in the red

  const choice = await bet('alice', 'bob', 'What happens to the project manager?', 'choice', { options: ['Quits', 'Gets fired', 'Gets reassigned'] }, 'Gets fired');
  await guess('bob', choice, 'Quits');
  await call('alice', 'POST', `/bets/${choice.id}/propose`, { outcome: 'Gets fired' });

  const waiting = await bet('alice', 'bob', 'How many lonkeros fit in the sauna cooler?', 'number', { integer: true, min: 0, max: null, minExclusive: false, maxExclusive: false }, '48');

  // Alice and Cara
  const freeform = await bet('alice', 'cara', 'What will the coach say first after the final whistle?', 'text', {}, '"We go again"');
  await guess('cara', freeform, '"Great fighting spirit"');
  await call('alice', 'POST', `/bets/${freeform.id}/propose`, { outcome: '"Great fighting spirit"', winner: 'them' });

  const future = await bet('alice', 'cara', 'When is the new office opening?', 'instant', { precision: 'day', allowPast: false, minLeadMinutes: 0 }, day(20));
  await guess('cara', future, day(60));

  const unguessed = await bet('cara', 'alice', 'What will the temperature be at midsummer?', 'number', { integer: false, min: null, max: null, minExclusive: false, maxExclusive: false });

  const tie = await bet('alice', 'cara', 'How many goals in the opening match?', 'number', { integer: true, min: 0, max: null, minExclusive: false, maxExclusive: false }, '3');
  await guess('cara', tie, '3');
  await call('cara', 'POST', `/bets/${tie.id}/propose-tie`);

  const cancelled = await bet('alice', 'cara', 'Does it snow in June?', 'yesno', {}, 'no');
  await call('alice', 'POST', `/bets/${cancelled.id}/cancel`);

  console.log('Lists');
  for (const p of people) await shot({ group: 'Bets', title: 'Bets list', as: p, url: '/' });
  for (const p of people) await shot({ group: 'Friends', title: 'Friends list, with bets', as: p, url: '/friends' });
  await shot({ group: 'Friends', title: 'Friend with open and settled bets', as: 'alice', url: `/friends/${myId.bob}` });
  await shot({ group: 'Friends', title: 'Friend who is ahead on the tab', as: 'bob', url: `/friends/${myId.alice}` });

  console.log('Bet details');
  const details = [
    [settled, 'Settled: closest guess wins', ['alice', 'bob']],
    [yesno, 'In play, with an all-in stake', ['alice', 'bob']],
    [choice, 'Outcome proposed, waiting for the other player to confirm', ['alice', 'bob']],
    [waiting, 'Waiting for the other player’s guess', ['alice', 'bob']],
    [freeform, 'Freeform outcome proposed with a verdict', ['alice', 'cara']],
    [future, 'Future date, with a tipping point', ['alice', 'cara']],
    [unguessed, 'Started without a guess', ['cara', 'alice']],
    [tie, 'Tie proposed', ['alice', 'cara']],
  ];
  for (const [b, title, who] of details) {
    for (const p of who) await shot({ group: 'Bet details', title, as: p, url: `/bets/${b.id}` });
  }

  // Finish a couple so the settled states (win, loss, draw) are visible too.
  console.log('Settling');
  await call('bob', 'POST', `/bets/${choice.id}/confirm`);
  await call('cara', 'POST', `/bets/${freeform.id}/confirm`);
  await call('alice', 'POST', `/bets/${tie.id}/confirm`);
  for (const [b, title, who] of [
    [choice, 'Settled: multiple choice', ['alice', 'bob']],
    [freeform, 'Settled: freeform, Cara was right', ['alice', 'cara']],
    [tie, 'Settled: called off as a tie', ['alice', 'cara']],
  ]) {
    for (const p of who) await shot({ group: 'Bet details', title, as: p, url: `/bets/${b.id}` });
  }
  await shot({ group: 'Bets', title: 'Bets list, after settling', as: 'alice', url: '/' });
  await shot({ group: 'Bets', title: 'Bets list, after settling', as: 'bob', url: '/' });
}

// ---------- gallery ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function gallery() {
  const groups = [...new Set(shots.map((s) => s.group))];
  const slug = (g) => g.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const sections = groups
    .map((g) => {
      const cards = shots
        .filter((s) => s.group === g)
        .map(
          (s) => `
        <article class="card">
          <header>
            <h3>${esc(s.title)}</h3>
            <p><span class="who">${esc(s.as)}</span> <code>${esc(s.url)}</code></p>
            ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
          </header>
          <div class="pics">
            ${s.images.map((i) => `<figure class="${i.vp}"><a href="${i.file}" target="_blank"><img src="${i.file}" loading="lazy" alt="${esc(`${s.title} (${i.label})`)}"></a><figcaption>${i.label}</figcaption></figure>`).join('')}
          </div>
        </article>`,
        )
        .join('');
      return `<section id="${slug(g)}"><h2>${esc(g)}</h2><div class="cards">${cards}</div></section>`;
    })
    .join('\n');
  const nav = groups.map((g) => `<a href="#${slug(g)}">${esc(g)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoJuBets UI gallery</title>
<style>
  :root { color-scheme: light dark; --bg: #f5ede6; --fg: #1b1218; --card: #fff; --line: #d9ccc2; --accent: #6a1f3a; --muted: #6b4f58; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1218; --fg: #f5ede6; --card: #292027; --line: #49333d; --accent: #d7b59a; --muted: #c4b4ba; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
  .top { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; }
  .top h1 { margin: 0; font-size: 18px; }
  .top nav { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .top a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .top label { margin-left: auto; color: var(--muted); }
  main { padding: 8px 24px 64px; }
  h2 { margin: 40px 0 12px; font-size: 22px; scroll-margin-top: 64px; }
  .cards { display: grid; gap: 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .card h3 { margin: 0 0 4px; font-size: 16px; }
  .card p { margin: 0; color: var(--muted); font-size: 13px; }
  .who { font-weight: 600; color: var(--fg); }
  .note { margin-top: 4px !important; }
  .pics { display: flex; gap: 20px; align-items: flex-start; margin-top: 12px; overflow-x: auto; }
  figure { margin: 0; flex: none; }
  figure img { display: block; border: 1px solid var(--line); border-radius: 8px; background: #fff; height: auto; }
  figure.mobile img { width: 280px; }
  figure.desktop img { width: 640px; }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
  body.hide-mobile figure.mobile, body.hide-desktop figure.desktop { display: none; }
  .generated { color: var(--muted); font-size: 12px; margin-top: 40px; }
</style>
</head>
<body>
<div class="top">
  <h1>LoJuBets UI gallery</h1>
  <nav>${nav}</nav>
  <label>Show <select id="vp"><option value="">mobile and desktop</option><option value="mobile">mobile only</option><option value="desktop">desktop only</option></select></label>
</div>
<main>
${sections}
<p class="generated">${shots.length} screens, generated ${new Date().toISOString()} by <code>npm run screenshots</code>. Click an image for full size.</p>
</main>
<script>
  const sel = document.getElementById('vp');
  const apply = () => { document.body.classList.toggle('hide-desktop', sel.value === 'mobile'); document.body.classList.toggle('hide-mobile', sel.value === 'desktop'); };
  sel.addEventListener('change', apply);
</script>
</body>
</html>
`;
}

// ---------- main ----------

try {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  console.log('Starting the app…');
  start('api', ['--import', 'tsx', 'server/dev.ts'], { PORT: String(API_PORT), DATABASE_URL: `file:${path.join(dataDir, 'lojubets.db')}`, DEV_LOGIN: 'on', APP_URL: base, NODE_ENV: 'development' });
  start('web', ['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], { API_PORT: String(API_PORT) });
  await waitFor(`http://localhost:${API_PORT}/api/config`, 'the API');
  await waitFor(`${base}/api/config`, 'the web app');

  browser = await chromium.launch();
  await scenarios();
  await browser.close();

  const file = path.join(out, 'index.html');
  writeFileSync(file, gallery());
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${shots.length} screens. Open ${file}`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopServers();
}
