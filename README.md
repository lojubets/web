<img src="icons/web/pwa-icon-192.png" alt="" width="72" align="right">

# LoJuBets

Bets between friends. Closest guess wins, and the prize is always one Gin & Tonic (GT).

- **Frontend:** React + TypeScript (Vite), mobile-first
- **Backend:** Express + TypeScript, served as a single Vercel serverless function under `/api`
- **Database:** libSQL (a local SQLite file in dev, free [Turso](https://turso.tech) in production)
- **Auth:** email/password, plus Google, Microsoft and Apple sign-in (OIDC, implemented in `server/auth.ts`, no auth SaaS)

## How it works

1. Sign up with just an email and password (or a provider). Optionally set a display name and profile picture on the Profile page; until then you're shown to friends by your email address.
2. Verify your own email address (automatic for Google/Apple; a confirmation link for email/password and Microsoft accounts), then invite a friend by email. They get a link (emailed if Resend is configured, otherwise you share it). Bets are only possible between connected users.
3. **Create a bet:** a question, an answer type and, optionally, your guess. Your guess stays hidden until your friend locks in theirs. Not sure yet? Leave your guess empty to record the bet right away and lock in a guess later; the bet starts once you have both guessed. Answer types and their rules (applied to both players' guesses):
   - **Number:** whole numbers only or decimals too; optional minimum and maximum, each inclusive or exclusive (negatives are allowed unless the minimum forbids them).
   - **Duration:** `3:05` (h:mm), `1:02:03`, or words like `3 hours and 5 minutes`, `25 days`, `12 weeks`, `3 months and 2 days`. A month counts as 30 days and a year as 365; `m` means minutes.
   - **Date or time:** date or date-and-time; whether past dates are allowed; and a minimum lead time ("at least now + 2 hours", checked when each player guesses).
   - **Yes or no:** "Will Kane win the Ballon d'Or?" The right answer wins; if you both picked the same answer (or, with multiple choice, neither of you was right), it's a draw.
   - **Multiple choice:** 2–8 options you write ("quit", "get fired", "get reassigned"). Each of you picks one; the one who picked the actual outcome wins.
   - **Freeform:** "What will Jose say?" Each of you writes an answer (up to 300 characters). There's nothing to measure, so whoever enters the result also says who was right (you, your friend, or neither), and the other player confirms or rejects that.
4. When the outcome is known, either of you proposes it and the other confirms (or rejects it). The closer guess wins one GT; equal distance is a draw.
5. **Cancelling and ties:** a bet can be cancelled by either player only while it is still waiting for a guess (the opponent declining it, or the creator withdrawing it). Once you've both guessed, either of you can **propose a tie**; if the other agrees, the bet is called off with no winner (it stays in the history, and no balance changes, an all-in stake included). If they refuse, the bet carries on.
6. **All-in:** whoever is in the red against that friend can go double-or-nothing on an in-play bet. The stake becomes their whole debt: win and it's back to even, lose and the debt doubles. Only one all-in can be open per friend at a time.
7. **Merging accounts:** signed up twice (say with Google and with an email and password)? On the Profile page choose **Merge accounts**, sign in to the other account (you stay signed in as this one), then choose whose email address, display name and photo the merged account keeps. Rules:
   - **Both accounts need a verified email address.** Both addresses stay on record, each with its verification status, and an invitation sent to either one reaches the merged account.
   - **Every login keeps working.** After the merge, the other account's Google, Microsoft, Apple or email/password login signs in to the merged account.
   - **One password.** An account has a single password. If both accounts sign in with a password, you choose a new one during the merge, and it replaces both: after that, either email address plus the new password signs in. If only one has a password, it is kept as it is.
   - **Friends and bets are combined.** A friend both accounts had appears once, and balances with them add up. Unfinished bets *between* the two accounts block the merge until they're finished or cancelled; finished ones are removed (a bet with yourself is meaningless).
   - The other account is deleted, and its sessions stop working. The whole merge is one database transaction: it happens completely or not at all.
   - Signing in to the other account through a provider only works for an account that already exists; it never creates one. No new Google/Microsoft/Apple configuration is needed.
8. **Email addresses:** the Profile page lists every address with its verification status and lets you remove any of them, with two protections: you can never remove your **only verified** address (an account that hasn't verified anything can't remove its address either, which would sidestep verification), and you can never remove the address that is your **only way to sign in**. Removing an address that is also a password login (email + password) removes that login too; the confirmation says so. You can also make any **verified** address the primary one (the one friends see when you haven't set a display name, and where emails go); an unverified address can't be primary, since that would lock the account out. Removing the primary address promotes another verified one, and provider logins (Google, Microsoft, Apple) don't depend on the address staying on your profile.

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

Both commands first stop any dev servers left over from an earlier run of this project (matched by command *and* folder, so other projects are untouched), so you can just run them again after a crash or a closed terminal. If something unrelated is holding port 3001 or 5173, they say so and don't start. Restart after editing a dotenv file. Variables already set in your shell win over the file. Both files are git-ignored.

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
| `PRIVACY_CONTACT_EMAIL` | recommended | the contact address shown on the public privacy policy page (`/privacy`); without it the page says to ask whoever invited you |
| `SUPPORT_EMAIL` | optional | where "I'm stuck deleting my account" messages go (needs Resend); never shown on the site |

`APP_URL` must be the public address people use. If it is still `http://localhost:5173` (easy to do when copying values from `.env.cloud`), Google sends users back to localhost after signing in; the app now refuses to start the sign-in and says so. After changing any variable, **redeploy**: Vercel applies new values only to new deployments.

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

## Design

The look is documented as a design system. Start with the **[brand guide](docs/brand-guide.md)** (colors and what they mean, typography, negative space, components, voice), then see it live at **`/styleguide`** in the running app. The tokens are in [`src/design/tokens.css`](src/design/tokens.css) and `npm test` enforces the contrast rules (including dark mode), so a color change that breaks a pairing fails the build.

## Layout

```
api/index.ts    Vercel entry point (exports the Express app)
server/         Express app, auth, db schema, bet rules (+ tests)
shared/types.ts API types shared by both sides
src/            React app (src/design = tokens and component styles)
docs/           brand guide
```
