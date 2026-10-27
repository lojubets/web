# Lojubets 🍺

Bets between friends. Closest guess wins, and the prize is always one beer.

- **Frontend:** React + TypeScript (Vite), mobile-first
- **Backend:** Express + TypeScript, served as a single Vercel serverless function under `/api`
- **Database:** libSQL (a local SQLite file in dev, free [Turso](https://turso.tech) in production)
- **Auth:** email/password, plus Google, Microsoft and Apple sign-in (OIDC, implemented in `server/auth.ts`, no auth SaaS)

## How it works

1. Sign in, set a name and profile picture.
2. Invite a friend by email. They get a link (emailed if Resend is configured, otherwise you share it). Bets are only possible between connected users.
3. **Create a bet:** a question, an answer type and your guess. Your guess stays hidden until your friend locks in theirs. Answer types and their rules (applied to both players' guesses):
   - **Number:** whole numbers only or decimals too; optional minimum and maximum, each inclusive or exclusive (negatives are allowed unless the minimum forbids them).
   - **Duration:** `3:05` (h:mm), `1:02:03`, or `3 hours and 5 minutes`.
   - **Date or time:** date or date-and-time; whether past dates are allowed; and a minimum lead time ("at least now + 2 hours", checked when each player guesses).
4. When the outcome is known, either of you proposes it and the other confirms (or rejects it). The closer guess wins one beer; equal distance is a draw.
5. **All-in:** whoever is in the red against that friend can go double-or-nothing on an in-play bet. The stake becomes their whole debt: win and it's back to even, lose and the debt doubles. Only one all-in can be open per friend at a time.

### Tipping point

For a future-dated bet, once the midpoint of the two guesses has passed and the event still hasn't happened, the later guess is closer whatever happens. But the app never assumes the event hadn't happened; the players might just not have entered the result yet. So after the tipping point both are asked:

- **It happened:** enter the result as usual (the other player confirms), and the closer guess wins.
- **It hasn't happened yet:** either player says so and the other confirms, and the later guess wins (identical guesses draw). If the other player disagrees, the bet goes back to in-play and they enter the real result instead.

Players see the tipping point on the bet, a heads-up section on the home screen, and (if email is configured) get an email about 2 days before and another when it has passed. It only applies when past dates are *not* allowed; if the event may already have happened, there's nothing to infer.

Balances are derived from settled bets, so there is no separate ledger to keep in sync.

## Develop

```bash
npm install
npm run dev      # web on :5173 (proxies /api to the API on :3001)
npm test
```

With no OAuth credentials configured, the login page shows a **dev login** form (never available in production). Use two browsers/profiles to play both sides.

Copy `.env.example` to `.env` to configure anything else (Node doesn't load it automatically, e.g. `node --env-file=.env`; `tsx watch --env-file=.env` works for the API).

## Deploy (Vercel Hobby, $0)

1. Create a Turso database (free tier): `turso db create lojubets` then `turso db tokens create lojubets`. Tables are created automatically on first request.
2. Import the repo in Vercel and set the env vars from `.env.example`: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `SESSION_SECRET`, `APP_URL`, plus provider credentials.
3. Register the redirect URI `APP_URL/api/auth/<google|microsoft|apple>/callback` with each provider.

### Sign-in providers

| Provider | Cost | Notes |
| --- | --- | --- |
| Google | free | Google Cloud Console → OAuth client (Web). |
| Microsoft | free | Entra ID app registration, supported accounts "any org + personal". Microsoft's email claim isn't trustworthy, so these accounts (like email/password ones) start unverified and confirm their address via an emailed link. |
| Apple | **$99/year** | Requires an Apple Developer Program membership (Services ID + Sign in with Apple key). This is the one part that can't be free. Leave the `APPLE_*` vars unset to hide the button. |

Each button appears only when its credentials are set.

### Email (invitations and verification)

Email/password and Microsoft accounts must verify their address (a one-time link, valid 24h, hashed at rest) before they can receive email-matched invitations or be linked to a Google/Apple account. Invite links work regardless.


Resend's free tier needs a verified domain to email anyone other than your own address. Without `RESEND_API_KEY`, verification emails can't be delivered (in dev the link is printed to the API console), and the app creates invitations with a share link instead (native share sheet on phones), which works fine for a handful of friends.

### Reminders cron

`vercel.json` schedules `/api/cron` daily to send the tipping-point emails (the most Vercel's free Hobby plan allows). Set `CRON_SECRET` in Vercel and it is sent automatically. For finer-grained reminders, point any free pinger (e.g. cron-job.org) at `/api/cron` with an `Authorization: Bearer <CRON_SECRET>` header.

## Layout

```
api/index.ts    Vercel entry point (exports the Express app)
server/         Express app, auth, db schema, bet rules (+ tests)
shared/types.ts API types shared by both sides
src/            React app
```
