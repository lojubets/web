# Architecture

How LoJuBets is put together, and the rules to follow when changing it. For what the app does, see the
[README](../README.md); for how to work in this repo (checks, screenshots), see [AGENTS.md](../AGENTS.md).

## The pieces

```
Browser: React SPA (src/)  ──fetch /api/*, session cookie──▶  Express API (server/)  ──▶  libSQL database
   │ reads/writes one localStorage key                         one Vercel function          (SQLite file locally,
   ▼                                                           (api/index.ts)                Turso in production)
 the user's model (src/store.ts)
```

| Folder | What lives there |
| --- | --- |
| `src/` | The frontend: React + TypeScript, built by Vite. `pages/` (one per route), `components/`, `design/` (CSS tokens and components), `store.ts` (the user's model), `hooks.ts` (data and action hooks), `api.ts` (the one `fetch` wrapper). |
| `server/` | The backend: Express + TypeScript. `app.ts` (routes), `auth.ts` (sessions, sign-in, OIDC), `bets.ts` (the bet engine), `betLogic.ts` (pure rules: parsing guesses, winners, tipping point, payments), `db.ts` (schema and migrations), `deletion.ts`, `merge.ts`, `email.ts`, `reminders.ts`. |
| `shared/` | Code both sides import: `types.ts` (every API request and response type), formatting helpers. |
| `api/index.ts` | The Vercel entry point; it just exports the Express app. |
| `scripts/` | `screenshots.mjs` (the UI gallery), dev helpers. |

Frontend and API share one origin: in production Vercel serves `dist/` and rewrites `/api/*` to the function; in
development Vite (:5173) proxies `/api` to the API (:3001). There is no CORS and no separate API host.

## Backend

- **The server is the source of truth.** Every rule (who may do what, when a bet settles, balances) is decided and
  validated on the server. The client only displays what the server sends and asks it to change things.
- **Request pipeline** (`app.ts`, in order): JSON body parsing → a CSRF check refusing cross-site writes → `ensureSchema`
  → public routes (`/api/config`, `/api/auth/*`, `/api/cron`, invitation lookup) → `requireAuth` (401 without a valid
  session) → routes that also need a verified email → the rest. Unknown `/api` paths answer 404 JSON.
- **Who is asking** comes from the session only: `uid(res)`. Never take a user id from the request to decide whose data
  to read or change.
- **Validate input with zod** at the top of each handler; answer `400 { error }` with a message a user can read.
- **Responses are per viewer.** `serializeBet(bet, viewer)` turns a stored bet into what that user may see (other
  players' guesses stay hidden until the bet starts; `needsMyAction`, `myNet` and the like are from their side).
- **Pure logic stays pure.** Anything that can be decided without the database goes in `betLogic.ts` and gets unit
  tests; `bets.ts` loads and saves.
- **Derived data isn't stored twice.** Balances are sums over `bet_settlements`; there is no separate ledger.
- **Schema changes** go in `db.ts`: `CREATE … IF NOT EXISTS` plus idempotent migrations that run on the first request.
  There are no migration files; existing databases must keep working.
- **Background work** (reminders, deadlines, finishing account deletions) runs from `/api/cron`, called daily by Vercel.

## API conventions

- JSON in and out; types in `shared/types.ts`. Errors are `{ error: string }` with a fitting status: `400` bad input,
  `401` not signed in, `403` not allowed, `404` not found or no longer yours, `409` not possible in the current state.
- `401` means "signed out": the client clears its stored model on it. `404` on a single resource means it is gone.
- **A change answers with the new state of what it changed**, so the client can update its model without asking again:
  - bet actions answer with the `Bet`;
  - invitation changes answer with `{ friends, invitations }` (plus their own fields);
  - account changes answer with `{ me }`.

  New endpoints that change the user's model must do the same. Only actions after which the item is simply gone
  (cancelling or leaving a bet) answer `{ ok: true }`.

## Frontend

- **Routing:** `App.tsx`. It loads the signed-in user (`/me`), starting from the stored copy, and gates pages: signed-out
  users go to `/login`, unverified users can only use `/profile`.
- **Styling:** CSS only, with design tokens in `src/design/tokens.css` and shared classes in `components.css`. Reuse the
  classes; `/styleguide` shows them.

### The user's model (`src/store.ts`)

The client keeps **the signed-in user's data, not copies of API responses**: `me`, `friends`, `invitations`, and
`bets` (each bet once, by id, plus `betIds`, the bets the user is in, newest first). Every screen derives what it
shows from it: a friend's page filters the user's bets, and a bet's page looks one up by id.

- **Reading:** use the hooks `useFriends`, `useInvitations`, `useMyBets`, `useBetsWith(friendId)` and `useBet(id)`.
  They show what the model holds at once, ask the server for the latest each time a screen mounts, and update the
  model with the answer. Every screen showing that data then redraws (an unchanged answer redraws nothing).
- **One copy of each thing:** a bet from the list, from its own page or from an action's answer is the same entry.
  Whether it is in the user's list follows from the bet itself (`isMine`).
- **localStorage:** the model is saved under the single key `lojubets:model:v1`, tagged with the user's id, so it shows
  at once after a reload, and other tabs pick up changes via the `storage` event. It is emptied on sign-out, on
  account deletion, when `/me` answers 401, and when a different user signs in. It holds no secrets: the session is an
  HttpOnly cookie the client never reads.
- **Data that isn't part of the model** (settings, merge preview, deletion status, cancel requests) uses the plain,
  uncached `useFetch`.
- **Adding to the model:** add the field to `Model`, a `Resource` and its `apply` case in `store.ts`, a hook in
  `hooks.ts`, and tests in `store.test.ts`. Only store the signed-in user's own data, and keep the privacy policy
  (`src/pages/Privacy.tsx`) and [auth-and-browser-storage.md](auth-and-browser-storage.md) in step. Don't add other
  browser storage (cookies, other keys, IndexedDB, service workers) without updating both.

### Changing things (actions)

1. Run the request through `useAction`: `act.run(fn, key)`. While it is pending, the pressed button shows a spinner
   (`aria-busy={act.busyOn(key)}`) and the buttons sharing the action are disabled (`disabled={act.busy}`). There is no
   optimistic update: nothing changes on screen until the server has accepted the change.
2. When the answer arrives, put it into the model: `putBet(bet)`, `putRelations({ friends, invitations })`,
   `setMe(me)` from `useMe()`, or `dropBet(id)` when the user left a bet.
3. Only then move on: navigate, reset the form, show a confirmation.
4. Data that changed as a side effect (friends' balances after a bet settles) refreshes in the background with
   `refresh('friends', true)`; don't make the user wait for it.

Errors from `act.run` land in `act.error`; show them next to the form or buttons.

## Where to read more

- [auth-and-browser-storage.md](auth-and-browser-storage.md): sessions, cookies, CSRF, the localStorage key.
- [account-deletion.md](account-deletion.md): how deleting an account interacts with open bets.
- [README](../README.md): the bet rules, local development, deployment and environment variables.
