# Instructions for AI coding agents

This file is read by GitHub Copilot and, through `CLAUDE.md`, by Claude Code. See `README.md` for how the app works and how to run it.

## Follow the architecture

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing code. It describes the frontend, the backend and the API, and the rules to keep: the server decides everything, the client reads the signed-in user's model (`src/store.ts`) and keeps it in localStorage, and a change answers with its new state, which the client puts into the model before moving on. When a change alters one of those rules, update the document in the same change.

## Keep the UI screenshots in step with the UI

`npm run screenshots` (see [scripts/screenshots.mjs](scripts/screenshots.mjs)) runs the app with a throwaway database, plays out scenarios with three users, and writes screenshots and a gallery page to `screenshots/index.html`. Developers use the gallery to review the UI without deploying it, so it must show what the app actually looks like.

Whenever a change affects what a user sees or can do, update `scripts/screenshots.mjs` in the same change:

- **New page, route or screen:** add a `shot(...)` for it, in the group where it belongs (or a new group).
- **New bet state, bet type, rule or action** (anything in `server/bets.ts`, `server/betLogic.ts`, `server/app.ts` that changes the states a bet can be in, or the buttons and messages on a bet): extend the scenario setup so the new state exists, and add shots of it from each player's point of view.
- **Changed text, buttons or layout** that a shot's description mentions: edit the description.
- **Removed or renamed screens, routes or API calls the script uses:** fix or remove the affected shots. The script must keep running to the end.
- **Visual-only changes** (CSS, spacing, colours) need no script change, but do regenerate the gallery to check them.

Every `shot(...)` has a `story` and an `expect`:

- `story` says which players are involved and what each has done so far, as a plain account of the state of the world (who bet on what, who guessed, who proposed or confirmed what, who owes whom).
- `expect` says what should be visible on that screen for the user it is taken as (`as`): the messages, buttons and values.

Write both from what the screen really shows, not from what you expect it to show. Check the descriptions against the generated images or page text, and keep them in step with the scenario code, since the gallery shows them next to the screenshot.

Before finishing a UI change, run:

```bash
npm run screenshots
```

and open `screenshots/index.html` to check that the new or changed screens look right. `screenshots/` is git-ignored; don't commit it. If the browser isn't installed, run `npx playwright install chromium` first.

## Other checks

Run `npm run typecheck` and `npm test` before finishing any change.
