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
      stopServers();
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
 * `as`: user key, or null for a signed-out visitor. `story` and `expect` describe the scenario (see `scenarios`).
 * `act` can click around before the picture is taken.
 */
async function shot({ group, title, story, expect, as, url, viewports = ['mobile', 'desktop'], act, fullPage = true }) {
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
  shots.push({ group, title, story, expect, as: as ? USERS[as].name : 'Signed out', url, images });
  console.log(`  ${group} › ${title}`);
}

// ---------- the scenarios ----------

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/*
 * Every shot says what it depicts:
 *   story:  who is involved and what each player has done so far (the state of the world)
 *   expect: what should be visible on this screen
 * The gallery shows both next to the screenshot, so keep them in step with the scenario code.
 */
async function scenarios() {
  const people = ['alice', 'bob', 'cara'];
  const NO_FRIENDS = 'Alice, Bob and Cara have each signed up with the dev login. Nobody has invited anyone yet.';

  console.log('Signed-out screens');
  await shot({ group: 'Signed out', title: 'Sign in', as: null, url: '/login', story: 'A visitor who is not signed in opens the app.', expect: 'The LoJuBets sign-in form (email and password) with "Forgot your password?" and "Create an account" links, the privacy policy notice and, because the dev login is on, a "Development only" form with name and email fields.' });
  await shot({ group: 'Signed out', title: 'Forgot password', as: null, url: '/forgot-password', story: 'A visitor who is not signed in has followed "forgot password".', expect: 'An explanation, an email field with a "Send reset link" button, and a "Back to sign in" link.' });
  await shot({ group: 'Signed out', title: 'Privacy policy', as: null, url: '/privacy', story: 'Anyone, signed in or not, opens the privacy policy.', expect: 'The privacy policy: who is responsible, what is stored and why.' });
  await shot({ group: 'Signed out', title: 'Style guide', as: null, url: '/styleguide', story: 'A developer opens the design reference page. It is public and needs no data.', expect: 'The brand colours, supporting colours, spacing scale, icons and component samples.' });

  console.log('A new user with no friends');
  for (const p of people) await session(p); // signs everyone up
  await shot({ group: 'First steps', title: 'Bets, nothing yet', as: 'alice', url: '/', story: NO_FRIENDS, expect: 'Alice’s Bets tab with the empty message "Bets are between friends. Invite someone to get started." and an "Invite a friend" button. The Bets tab has no badge.' });
  await shot({ group: 'First steps', title: 'Friends, nothing yet', as: 'alice', url: '/friends', story: NO_FRIENDS, expect: 'Alice’s Friends tab saying "No friends yet. Invite someone below." with the "Invite a friend" email form.' });
  await shot({ group: 'First steps', title: 'Profile', as: 'alice', url: '/profile', story: `${NO_FRIENDS} Alice's email came from the dev login, so it counts as verified.`, expect: 'Alice’s profile: her initials as avatar, the display name field, her verified primary email address, her "Development login" sign-in method, the option to add a password, and the merge and delete account sections.' });
  await shot({ group: 'First steps', title: 'Merge accounts', as: 'alice', url: '/merge', story: NO_FRIENDS, expect: 'The merge page explaining that Alice stays signed in as this account, with a form for signing in to the other account by email and password and a "Development only" dev login form for the other account.' });

  console.log('Inviting friends');
  const toBob = await call('alice', 'POST', '/invitations', { email: USERS.bob.email });
  const toCara = await call('alice', 'POST', '/invitations', { email: USERS.cara.email });
  const invitePath = (link) => new URL(link).pathname;
  const INVITED = 'Alice has invited Bob and Cara by email. Neither has accepted yet.';
  await shot({ group: 'Invitations', title: 'Alice has invited two people', as: 'alice', url: '/friends', story: INVITED, expect: 'Alice’s Friends tab with a "Pending invitations" list holding bob@example.com and cara@example.com, each with "Share link" and "Revoke" buttons.' });
  await shot({ group: 'Invitations', title: 'Bob has a pending invitation', as: 'bob', url: '/friends', story: INVITED, expect: 'Bob’s Friends tab with an "Invitations for you" card: Alice Aaltonen "wants to connect", with Accept and Decline buttons.' });
  await shot({ group: 'Invitations', title: 'Invite link, signed in', as: 'bob', url: invitePath(toBob.link), story: `${INVITED} Bob is signed in and opens the link Alice sent him.`, expect: 'The headline "Alice Aaltonen wants to bet you a Gin & Tonic" and an "Accept invitation" button.' });
  await shot({ group: 'Invitations', title: 'Invite link, signed out', as: null, url: invitePath(toCara.link), story: 'Alice has invited Cara. Cara opens the invite link but is not signed in.', expect: 'The same headline, but the button reads "Sign in to accept".' });

  const { received } = await call('bob', 'GET', '/invitations');
  await call('bob', 'POST', `/invitations/${received[0].id}/accept`);
  await call('cara', 'POST', `/invitations/token/${toCara.link.split('/').pop()}/accept`);
  const myId = {}; // user ids, to name the opponent when creating a bet
  for (const p of people) myId[p] = (await call(p, 'GET', '/me')).id;

  const FRIENDS = 'Bob and Cara have accepted Alice’s invitations, so Alice is friends with both. No bets exist yet.';
  await shot({ group: 'Friends', title: 'Friends list, no bets yet', as: 'alice', url: '/friends', story: FRIENDS, expect: 'Alice’s Friends tab listing Bob Berg and Cara Cortez, each marked "You and … are even". No pending invitations remain.' });
  await shot({ group: 'Friends', title: 'A friend with no bets', as: 'alice', url: `/friends/${myId.bob}`, story: FRIENDS, expect: 'Alice’s page for Bob: "You and Bob Berg are even", a "New bet with Bob Berg" button and "No bets yet."' });

  console.log('Creating a bet');
  const FORM = `${FRIENDS} Alice taps "New bet".`;
  await shot({ group: 'Creating a bet', title: 'New bet form', as: 'alice', url: '/bets/new', story: FORM, expect: 'The form with a friend picker (Bob Berg and Cara Cortez), the question field and six answer types with "A number" selected. Below are the number rules (whole numbers only, minimum, maximum), the optional guess field and the "Propose bet · 1 GT" button.' });
  const KINDS = [
    ['Duration', 'A duration', 'a "How to write a duration" help box and a duration guess field'],
    ['Date or time', 'A date or time', 'date rules (date or date and time, allowing past dates, a minimum lead time before guesses) and a date guess field'],
    ['Yes or no', 'Yes or no', 'Yes and No buttons for the guess and no extra rules'],
    ['Multiple choice', 'Multiple choice', 'an options editor (two empty options and "Add an option") and the guess field'],
    ['Freeform', 'Freeform', 'a free text guess field and no extra rules'],
  ];
  for (const [kind, label, shows] of KINDS) {
    await shot({
      group: 'Creating a bet',
      title: `New bet: ${kind.toLowerCase()}`,
      as: 'alice',
      url: '/bets/new',
      story: `${FORM} She then picks the answer type "${label}".`,
      expect: `"${label}" is the selected answer type, and the part of the form below it changes to show ${shows}.`,
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

  // What has happened, in order, shared by every screen below that follows this setup.
  const HISTORY =
    'Alice and Bob: (1) Alice bet Bob on the length of the hockey final, guessing 2:15; Bob guessed 3 hours; Alice proposed the result 2:30 and Bob confirmed it, so Alice won and Bob owes her 1 GT. ' +
    '(2) Alice bet on whether Kane wins the Ballon d’Or (she said yes, Bob said no); Bob, being in the red, went all-in on it. ' +
    '(3) Alice bet on what happens to the project manager (she said "Gets fired", Bob "Quits") and proposed the outcome "Gets fired", which Bob has not confirmed yet. ' +
    '(4) Alice started a bet about the sauna cooler, guessing 48; Bob has not guessed. ' +
    'Alice and Cara: (5) both guessed on the coach’s first words, and Alice proposed that Cara’s answer was right, awaiting Cara’s confirmation. ' +
    '(6) both guessed on the new office opening date (Alice 20 days ahead, Cara 60 days ahead). ' +
    '(7) Cara started a bet about the midsummer temperature without a guess of her own; Alice has not guessed. ' +
    '(8) both guessed 3 goals in the opening match and Cara proposed calling it a tie, awaiting Alice. ' +
    '(9) Alice started and then cancelled a snow-in-June bet, which is not shown anywhere.';

  console.log('Lists');
  await shot({ group: 'Bets', title: 'Bets list', as: 'alice', url: '/', story: HISTORY, expect: 'Alice’s Bets tab. "Your move": the opening-match tie ("Agree to call it off?") and the midsummer bet ("Your guess is needed"). "In play": the office opening, the coach bet (waiting for Cara to confirm), the sauna cooler (waiting for Bob’s guess), the project manager (waiting for Bob to confirm) and the all-in Kane bet. "Settled": the hockey bet. The cancelled bet is absent.' });
  await shot({ group: 'Bets', title: 'Bets list', as: 'bob', url: '/', story: HISTORY, expect: 'Bob’s Bets tab. "Your move": the sauna cooler ("Your guess is needed") and the project manager ("Confirm the outcome"). "In play": the Kane bet with an "All-in 1 GT" tag. "Settled": the hockey bet, "Alice Aaltonen won". The Bets tab badge shows 2. Bob has no bets with Cara.' });
  await shot({ group: 'Bets', title: 'Bets list', as: 'cara', url: '/', story: HISTORY, expect: 'Cara’s Bets tab. "Your move": the midsummer bet ("Your guess is needed") and the coach bet ("Confirm the outcome"). "In play": the opening-match tie ("Waiting for Alice Aaltonen to agree to a tie") and the office opening. The Bets tab badge shows 2. She has no bets with Bob.' });
  await shot({ group: 'Friends', title: 'Friends list, with bets', as: 'alice', url: '/friends', story: HISTORY, expect: 'Alice’s Friends tab: "Bob Berg owes you 1 GT" with 3 open bets, and "You and Cara Cortez are even" with 4 open bets. The Bets tab badge shows Alice’s pending actions.' });
  await shot({ group: 'Friends', title: 'Friends list, with bets', as: 'bob', url: '/friends', story: HISTORY, expect: 'Bob’s Friends tab with only Alice: "You owe Alice Aaltonen 1 GT", 3 open bets.' });
  await shot({ group: 'Friends', title: 'Friends list, with bets', as: 'cara', url: '/friends', story: HISTORY, expect: 'Cara’s Friends tab with only Alice: "You and Alice Aaltonen are even", 4 open bets.' });
  await shot({ group: 'Friends', title: 'Friend with open and settled bets', as: 'alice', url: `/friends/${myId.bob}`, story: HISTORY, expect: 'Alice’s page for Bob: "Bob Berg owes you 1 GT", the three open bets with their status lines, and the hockey bet marked "You won".' });
  await shot({ group: 'Friends', title: 'Friend who is ahead on the tab', as: 'bob', url: `/friends/${myId.alice}`, story: HISTORY, expect: 'Bob’s page for Alice from the other side: "You owe Alice Aaltonen 1 GT" and the same four bets, the hockey one marked "Alice Aaltonen won".' });

  console.log('Bet details');
  const details = [
    {
      bet: settled,
      title: 'Settled: closest guess wins',
      story: 'Alice and Bob bet on the length of the hockey final. Alice guessed 2:15, Bob guessed 3 hours. Alice proposed the real result, 2:30, and Bob confirmed it. Alice’s guess was closer.',
      expect: { alice: 'Alice’s guess (2 hours 15 minutes), Bob’s guess (3 hours), the outcome 2 hours 30 minutes and "You won 1 GT! Bob Berg owes you."', bob: 'Bob’s guess (3 hours), Alice’s guess (2 hours 15 minutes), the outcome and "Alice Aaltonen won. You owe 1 GT."' },
    },
    {
      bet: yesno,
      title: 'In play, with an all-in stake',
      story: 'Alice and Bob bet on whether Kane wins the Ballon d’Or. Alice guessed yes, Bob guessed no, so the bet is in play. Bob owed Alice 1 GT from the hockey bet, so he went all-in on this one: the stake is his whole debt.',
      expect: { alice: 'Both guesses (hers Yes, Bob’s No), the line "All-in: double or nothing for 1 GT", the Yes/No result form ("It happened! What was the actual result?") with "Propose result", and "Propose a tie".', bob: 'Both guesses (his No, Alice’s Yes), the all-in line, the same result form and "Propose a tie".' },
    },
    {
      bet: choice,
      title: 'Outcome proposed, waiting for the other player to confirm',
      story: 'Alice and Bob bet on what happens to the project manager (Quits / Gets fired / Gets reassigned). Alice guessed "Gets fired", Bob guessed "Quits". Alice has proposed the outcome "Gets fired"; Bob has not responded.',
      expect: { alice: 'Both picks, "Proposed outcome: Gets fired", "Waiting for Bob Berg to confirm the result." and a "Withdraw my proposal" button.', bob: 'Both picks, "Alice Aaltonen says the result was Gets fired. Agree?" with "Confirm result", "That’s not right" and "No, I say…".' },
    },
    {
      bet: waiting,
      title: 'Waiting for the other player’s guess',
      story: 'Alice started a number bet with Bob about how many lonkeros fit in the sauna cooler and locked in her guess, 48. Bob has not guessed yet.',
      expect: { alice: 'Her guess 48, Bob’s guess shown as "Hidden", "Waiting for Bob Berg to guess." and a "Cancel bet" button.', bob: 'The rules line ("Whole numbers only · at least 0"), his guess as "—", Alice’s as "Hidden", "Alice Aaltonen has locked in their guess.", a guess field with "Lock in my guess" and a "Decline bet" button.' },
    },
    {
      bet: freeform,
      title: 'Freeform outcome proposed with a verdict',
      story: 'Alice and Cara bet on what the coach says first after the final whistle. Alice guessed "We go again", Cara guessed "Great fighting spirit". Alice proposed that the coach said "Great fighting spirit" and that Cara was right. Cara has not responded.',
      expect: { alice: 'Both guesses, "Proposed outcome: \"Great fighting spirit\"", "Waiting for Cara Cortez to confirm the result." and "Withdraw my proposal".', cara: 'Both guesses, the proposed outcome, "Alice Aaltonen says the result was … and that you were right. Agree?" with "Confirm result", "That’s not right" and "No, I say…".' },
    },
    {
      bet: future,
      title: 'Future date, with a tipping point',
      story: 'Alice and Cara bet on when the new office opens. Alice guessed a date 20 days from now, Cara a date 60 days from now. Both guesses are locked in and the bet is in play.',
      expect: { alice: 'Both guesses as dates (hers earlier), the "Tipping point" date halfway between them with an explanation that Cara’s later guess is guaranteed closer if the event hasn’t happened by then, the result form, and "Propose a tie".', cara: 'The same dates and tipping point from her side, worded "your guess is guaranteed to be closer".' },
    },
    {
      bet: unguessed,
      title: 'Started without a guess',
      story: 'Cara started a number bet with Alice about the midsummer temperature but left her own guess empty to guess later. Alice has not guessed either.',
      expect: { cara: 'Her guess shown as "—", Alice’s as "Hidden", a guess field with "Lock in my guess" and "Cancel bet".', alice: 'Her guess as "—" and Cara’s as "Hidden", a guess field with "Lock in my guess" and "Decline bet".' },
    },
    {
      bet: tie,
      title: 'Tie proposed',
      story: 'Alice and Cara both guessed 3 goals in the opening match. Cara proposed calling the bet a tie. Alice has not answered.',
      expect: { alice: 'Both guesses (3), "Cara Cortez proposes a tie: call the bet off, and nobody owes anything. Agree?" with "Yes, call it off" and "No, keep it going".', cara: 'Both guesses (3), "Waiting for Alice Aaltonen to agree to call the bet off as a tie." and "Withdraw my proposal".' },
    },
  ];
  for (const d of details) {
    for (const p of Object.keys(d.expect)) {
      await shot({ group: 'Bet details', title: d.title, as: p, url: `/bets/${d.bet.id}`, story: d.story, expect: d.expect[p] });
    }
  }

  // Finish a few so the settled states are visible too.
  console.log('Settling');
  await call('bob', 'POST', `/bets/${choice.id}/confirm`);
  await call('cara', 'POST', `/bets/${freeform.id}/confirm`);
  await call('alice', 'POST', `/bets/${tie.id}/confirm`);
  const settledDetails = [
    {
      bet: choice,
      title: 'Settled: multiple choice',
      story: 'Continuing the project manager bet: Bob confirmed Alice’s proposed outcome, "Gets fired". Alice had picked it, Bob had picked "Quits".',
      expect: { alice: 'Both picks, the outcome "Gets fired" and "You won 1 GT! Bob Berg owes you."', bob: 'Both picks, the outcome and "Alice Aaltonen won. You owe 1 GT."' },
    },
    {
      bet: freeform,
      title: 'Settled: freeform, Cara was right',
      story: 'Continuing the coach’s-words bet: Cara confirmed Alice’s verdict that Cara’s answer was right.',
      expect: { alice: 'Both guesses, the outcome and "Cara Cortez won. You owe 1 GT."', cara: 'Both guesses, the outcome and "You won 1 GT! Alice Aaltonen owes you."' },
    },
    {
      bet: tie,
      title: 'Settled: called off as a tie',
      story: 'Continuing the opening-match bet: Alice agreed to Cara’s tie proposal, so the bet was called off with no winner and no balance changes.',
      expect: { alice: 'Both guesses (3) and "Called off by agreement. Nobody owes anything."', cara: 'The same: both guesses and "Called off by agreement. Nobody owes anything."' },
    },
  ];
  for (const d of settledDetails) {
    for (const p of Object.keys(d.expect)) {
      await shot({ group: 'Bet details', title: d.title, as: p, url: `/bets/${d.bet.id}`, story: d.story, expect: d.expect[p] });
    }
  }
  const AFTER = `${HISTORY} Afterwards Bob confirmed bet 3, Cara confirmed bet 5 and Alice agreed to the tie in bet 8, so those three are now settled.`;
  await shot({ group: 'Bets', title: 'Bets list, after settling', as: 'alice', url: '/', story: AFTER, expect: 'Alice’s Bets tab: "Your move" now only has the midsummer bet; "In play" has the office opening, sauna cooler and Kane bet; "Settled" gains the opening match ("Called off by agreement"), the coach bet ("Cara Cortez won") and the project manager ("You won"), above the hockey bet.' });
  await shot({ group: 'Bets', title: 'Bets list, after settling', as: 'bob', url: '/', story: AFTER, expect: 'Bob’s Bets tab: "Your move" holds only the sauna cooler; "In play" the Kane bet; "Settled" now has the project manager ("Alice Aaltonen won") above the hockey bet. The Bets tab badge shows 1.' });
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
            <p><span class="who">${esc(s.as)}</span></p>
          </header>
          <dl class="desc"><dt>Scenario</dt><dd>${esc(s.story)}</dd><dt>Screen</dt><dd>${esc(s.as)} is looking at <code>${esc(s.url)}</code></dd><dt>Should show</dt><dd>${esc(s.expect)}</dd></dl>
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
  .desc { margin: 10px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 13px; max-width: 70ch; }
  .desc dt { font-weight: 600; color: var(--muted); }
  .desc dd { margin: 0; }
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
