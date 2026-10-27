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
npm test
```

There are two ways to run the app on your machine. Each reads its own dotenv file, and both serve the web app on :5173 (proxying `/api` to the API on :3001).

| | `npm run dev` / `npm run dev:local` | `npm run dev:cloud` |
| --- | --- | --- |
| Database | SQLite file `local.db`, fully offline | a Turso database |
| Config file | `.env.local` (optional) | `.env.cloud` (required) |
| Template | `.env.local.example` | `.env.cloud.example` |
| Sign-in | dev login form (no OAuth needed), email/password | email/password and real providers; dev login is off unless `DEV_LOGIN=on` |

**Local** works with zero setup: just `npm run dev`. Use two browsers/profiles to play both sides. Copy `.env.local.example` to `.env.local` if you want to try real providers or email.

**Cloud** needs `.env.cloud` (copy the template and fill in `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `SESSION_SECRET`; see [Turso](#deploy-vercel-hobby-0) below for where they come from). Point it at a *separate* Turso database such as `lojubets-dev`, not production; the free tier allows plenty. The app refuses to start with a `libsql://` URL and no token.

Restart after editing a dotenv file. Variables already set in your shell win over the file. Both files are git-ignored.

## Production

Production does **not** use a dotenv file. Vercel stores the variables you configure and hands them to the function as ordinary environment variables (`process.env`), which is where the app reads everything. Set them in the Vercel dashboard (Project → Settings → Environment Variables) or with `vercel env add <NAME> production`, then redeploy.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Turso `libsql://…` URL. A `file:` URL is rejected in production. |
| `DATABASE_AUTH_TOKEN` | yes | Turso token |
| `SESSION_SECRET` | yes | long random string |
| `APP_URL` | yes | your public URL, e.g. `https://lojubets.vercel.app` (falls back to Vercel's production URL) |
| `CRON_SECRET` | yes | protects `/api/cron`; Vercel Cron sends it automatically |
| `GOOGLE_*`, `MICROSOFT_*`, `APPLE_*` | per provider | see [Sign-in providers](#sign-in-providers) |
| `RESEND_API_KEY`, `RESEND_FROM` | optional | see [Email](#email-invitations-and-verification) |

The dev login is never available in production, whatever `DEV_LOGIN` says. Watch out: `vercel env pull` writes to `.env.local` by default, which would silently switch your local mode to those values. Use `vercel env pull .env.cloud` instead if you want that.

## Deploy (Vercel Hobby, $0)

1. **Create a Turso database** (free tier), using the [Turso CLI](https://docs.turso.tech/cli/installation):

   ```bash
   turso auth login
   turso db create lojubets
   turso db show lojubets --url        # -> DATABASE_URL, e.g. libsql://lojubets-<your-org>.turso.io
   turso db tokens create lojubets     # -> DATABASE_AUTH_TOKEN
   ```

   Tables are created automatically on the first request, so there is nothing to migrate by hand.
2. **Set the database variables.** Both are required for Turso:

   | Variable | Local development | Turso (production) |
   | --- | --- | --- |
   | `DATABASE_URL` | `file:local.db` (the default; a SQLite file in the project folder) | the `libsql://…turso.io` URL from `turso db show --url` |
   | `DATABASE_AUTH_TOKEN` | not needed, leave empty | the token from `turso db tokens create` |

   The app refuses to start with a `libsql://` URL and no token. The token is a secret: put it in Vercel's environment variables, never in git. To try Turso from your machine, put the same two values in `.env.cloud` and run `npm run dev:cloud`.
3. Import the repo in Vercel and set the [production variables](#production) above.
4. Register the redirect URI `APP_URL/api/auth/<google|microsoft|apple>/callback` with each provider.

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
