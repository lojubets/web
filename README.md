# Lojubets 🍺

Bets between friends. Closest guess wins, and the prize is always one beer.

- **Frontend:** React + TypeScript (Vite), mobile-first
- **Backend:** Express + TypeScript, served as a single Vercel serverless function under `/api`
- **Database:** libSQL (a local SQLite file in dev, free [Turso](https://turso.tech) in production)
- **Auth:** Google, Microsoft and Apple sign-in (OIDC, implemented in `server/auth.ts`, no auth SaaS)

## How it works

1. Sign in, set a name and profile picture.
2. Invite a friend by email. They get a link (emailed if Resend is configured, otherwise you share it). Bets are only possible between connected users.
3. **Create a bet:** a question, a type (*number* or *date*) and your guess. Your guess stays hidden until your friend locks in theirs.
4. When the outcome is known, either of you proposes it and the other confirms (or rejects it). The closer guess wins one beer; equal distance is a draw.
5. **All-in:** whoever is in the red against that friend can go double-or-nothing on an in-play bet. The stake becomes their whole debt: win and it's back to even, lose and the debt doubles. Only one all-in can be open per friend at a time.

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
| Microsoft | free | Entra ID app registration, supported accounts "any org + personal". Personal accounts' email isn't verified by Microsoft, so those users are matched to invitations via the invite link rather than their email. |
| Apple | **$99/year** | Requires an Apple Developer Program membership (Services ID + Sign in with Apple key). This is the one part that can't be free. Leave the `APPLE_*` vars unset to hide the button. |

Each button appears only when its credentials are set.

### Invitation emails

Resend's free tier needs a verified domain to email anyone other than your own address. Without `RESEND_API_KEY` the app creates the invitation and offers a share link (native share sheet on phones), which works fine for a handful of friends.

## Layout

```
api/index.ts    Vercel entry point (exports the Express app)
server/         Express app, auth, db schema, bet rules (+ tests)
shared/types.ts API types shared by both sides
src/            React app
```
