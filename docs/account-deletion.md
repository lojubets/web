# Proposal: account deletion (GDPR right to erasure)

Status: **proposal, no code**. Written against the schema in `server/db.ts` and the routes in `server/app.ts`, `server/auth.ts` and `server/merge.ts` as of `main`.

## 1. Goal

A "Delete my account" button on the Profile page that satisfies GDPR Art. 17 (erasure) without wrecking the records of the *other* people who bet with the account holder. The hard part is not deleting the user's own row; it is deciding what happens to `bets` rows that name two people.

## 2. What the data model looks like today

There are no foreign keys or `ON DELETE` clauses; every `user_id` is a plain `TEXT` column, so deletion has to be done by hand, in one `db.batch(..., 'write')` as `merge.ts` already does.

| Table | Personal data? | Notes |
|---|---|---|
| `users` | email, name | `email` is the primary; `name` may be empty (display falls back to email) |
| `user_emails` | every email the account has | PK `(user_id, email)` |
| `avatars` | photo (base64) | one row per user |
| `identities` | provider + `subject` | `subject` is the email for `password`/`dev` logins and an opaque provider id for Google/Apple etc. Still a persistent identifier, so personal data |
| `password_credentials` | password hash | keyed by `subject`, not `user_id` (reach it via `identities`) |
| `credentials` | legacy password hash | keyed by `user_id`; migration leftover |
| `email_verifications` | email + hashed token | |
| `connections` | friendships | `(user_a, user_b)` |
| `invitations` | `email` of an invitee (a third party's data), `inviter_id`, `token` | |
| `bets` | `question` (free text, may name people), guesses, `creator_id`, `opponent_id`, `winner_id`, `outcome_proposed_by`, `settled_by`, stake | statuses: `awaiting_guess`, `active`, `awaiting_confirmation`, `settled`, `cancelled` |
| `bet_reminders` | none (bet id + kind) | |

Sessions are **stateless** signed JWT cookies (`session`, `auth.ts`); there is no sessions table. The session check already treats "account no longer exists" as signed out, so deleting the `users` row invalidates every session on every device immediately. The merge cookie works the same way. Nothing to delete there, but also no way to revoke a session without deleting the user (relevant to the cooling-off option below).

Balances (the running "Lonkeros X owes Y" tally, `balanceFor` in `betLogic.ts`) are *derived* from settled bets by `winnerId` and `stake`. They are not stored, which matters for the options below.

## 3. What the button does (summary)

1. Opens a confirmation flow (section 7).
2. Offers a data export first (section 10).
3. If the account has ongoing bets, it does **not** delete yet. It puts the account into "deletion requested" and asks each counterparty to cancel the bet (section 6). Deletion then happens by itself as soon as nothing ongoing is left, or by default after 30 days of silence. With no ongoing bets, deletion is immediate.
4. In one transaction: hard-deletes the account's personal data (section 4) and rewrites the bets it participated in according to the chosen policy (section 5).
5. Clears the session cookie and shows a "your account was deleted" page.

## 4. Hard-deleted vs kept

**Hard-deleted, no residue:**

- `users` row (email, name)
- `user_emails` rows
- `avatars` row
- `identities` rows (all providers) and their `password_credentials` rows (select by `subject` via `identities` *before* deleting the identities), plus any legacy `credentials` row
- `email_verifications` rows
- `connections` rows where the user is either side: re-pointed to the placeholder for friends who share bets with the user (section 5), deleted otherwise
- `invitations` where `inviter_id = user` (all statuses), and invitations whose `email` matches any of the user's addresses (case-insensitive, as `users_email` is indexed on `lower(email)`); see section 8
- Sessions: invalidated implicitly (stateless JWT, user row gone)

**Kept, but only in the form decided in section 5:**

- `bets` rows and their `bet_reminders`.

**Not needed:** revoking Google or Apple grants. The app verifies the provider's `id_token` at sign-in and stores only `provider` + `subject` (see `identities`); it keeps no access or refresh tokens, so deleting the identity rows removes everything we hold. The only trace left is the app's entry in the user's own Google/Apple account settings, which the user controls. (Apple's token-revocation requirement targets App Store apps; this is a web app.)

**Kept in no form:** nothing derived from the above. No "deleted users" tombstone table with emails or hashes. Deleting must not leave an email hash either: a hash of a low-entropy identifier like an email is still personal data under GDPR (pseudonymous, trivially reversible by guessing).

## 5. The core question: bets with other users

Each bet is a record of an agreement between two people. Deleting A's account affects B's records in three ways: B's history (list of bets), B's balance against A, and B's ability to see what they agreed to. Options:

### Option A: cascade delete (delete every bet A took part in)

- Simplest to reason about and trivially GDPR-compliant: nothing about A remains.
- **Bad for B.** B's history shrinks silently and B's balances change retroactively. If A owed B 5 lonkeros, deleting makes the debt vanish, which is an incentive to delete one's account to dodge a loss. Also, B may have written the `question` and their own guess, which are B's data too.
- Violates the integrity of results for the surviving participant. Not recommended.

### Option B: full removal from everyone's histories

Same effect as A for B's view (the bets are gone for B too); listed separately only because it is sometimes proposed as "remove A from the bets but keep them". With only two participants per bet, a bet minus one side is meaningless, so B collapses into A. Not recommended.

### Option C: anonymize A into a placeholder ("Deleted user") and keep the bets

Keep each bet row; replace A's identity with a placeholder. Mechanically (decided: **one placeholder per deletion**): create a fresh `users` row with a random id, name `Deleted user`, no email, no identities, and a `deleted_at` timestamp that marks it as a placeholder. Re-point `creator_id`/`opponent_id`/`winner_id`/`outcome_proposed_by` and the deleted user's `connections` rows at it. A fresh id (rather than keeping the old one) means old session cookies and any logged ids stop meaning anything. Then:

- B keeps their history, results and balance; "winner" semantics and `balanceFor` keep working unchanged.
- B sees "Deleted user" as the opponent. B obviously still knows who they bet with; that is B's own knowledge and not data held about A by the service.
- **GDPR caveat.** Anonymized data is outside GDPR only if A is truly not identifiable by anyone, including with reasonable additional effort and B's own knowledge. Two residual risks:
  1. The free-text `question` and the guesses can name or describe A ("Will Matti finish his thesis?"). The record is then identifiable *from content*, regardless of ids.
  2. One placeholder id is shared by all of one person's bets with B, so B can tell those bets belong to the same (former) person. That is deliberate: B already knows who they bet with, per-person balances and `/api/bets?with=` keep working, and different deleted people stay distinguishable. The placeholder id maps to nothing once the original row is gone.
- Mitigations: (a) blank the free text for the deleted party's side where we can (A's guess `creator_guess`/`opponent_guess` becomes unavailable, replaced by "not shown"), (b) **keep `question` (decided)**: it is as much B's data as A's, so it is not blanked even when A wrote it; the deletion dialog tells the user that text they wrote into shared bets stays visible to the other participant, and (c) give B a "remove this bet from my history" action (section 5a), so B can erase their own copy if they want.
- The legal basis for keeping the shared record is B's legitimate interest in their own accurate history; this is also the standard pattern for messaging and ledger-like products.

### Option D (variant of C): anonymize, but drop what is identifying in the bet

C plus: for *settled* bets keep only what B needs to preserve the result (question, B's guess, outcome, winner as "B" or "other", stake, dates) and null A's guess. For *cancelled* bets, delete outright: no result to preserve, and nobody's balance depends on them. This is C with data minimization.

### Comparison

| | A cascade | B remove from all | C placeholder | D placeholder + minimize |
|---|---|---|---|---|
| Other user's history | lost | lost | kept | kept |
| Other user's balance | silently changes | silently changes | unchanged | unchanged |
| Result integrity | breaks | breaks | holds | holds |
| Incentive to delete to dodge a debt | yes | yes | no | no |
| GDPR strength | strongest | strongest | strong, *if* free text is not identifying | stronger than C |
| Implementation | small | small | medium (placeholder user, UI copy) | medium |

**Recommendation: Option D**, with one placeholder per deletion. Settled bets are anonymized, cancelled bets are deleted, ongoing bets follow the cancellation flow (section 6).

### 5a. Balances and "remove from my history"

- **Balances (decided):** a deleted user's placeholder is shown exactly like any other friend. Because the deleted user's `connections` rows are re-pointed to the placeholder instead of deleted, `/api/friends` (which is built from `connections`), `balanceFor` and `/api/bets?with=` need no special handling beyond the name and avatar. The placeholder cannot receive new bets (`areConnected` plus a `deleted_at` check).
- **Remove from my history (decided):** for a bet whose other participant is a placeholder, the remaining participant gets a "Remove from my history" action. Since nobody else holds the record, this hard-deletes the bet row (and its `bet_reminders`). Warn first that, for a settled bet, it changes their balance with that person. When the last bet with a placeholder is removed, the placeholder and its connection are deleted too. Decided: this action exists **only** for bets with a since-deleted user. It is not offered for bets between two live users.

## 6. Ongoing bets

**Decision (maintainer):** ongoing bets are not voided unilaterally. Erasure waits for them, but not forever: the user asks each counterparty to cancel, and if 30 days pass without the counterparty responding, erasure proceeds by default.

Statuses that count as ongoing: `awaiting_guess`, `active`, `awaiting_confirmation`. (`settled` and `cancelled` are historical and do not hold up deletion.) This builds on what merge already does: `previewFor` in `merge.ts` lists unfinished bets as blockers.

Rejected alternatives: voiding all ongoing bets at once (changes the other participant's records unilaterally) and auto-resolving (the service cannot know who won).

### The flow

1. **Request.** The user confirms deletion (section 7). If there are no ongoing bets, deletion runs immediately and the flow ends here.
2. **Account enters "deletion requested".** A new `users.deletion_requested_at` timestamp is set. The user can still sign in (to settle bets and see status) and can withdraw the request. While requested, the account cannot start new bets or send invitations, and counterparties cannot start new bets with it (otherwise the set of ongoing bets never shrinks). Note this is the opposite of a cooling-off period: nothing is "undoable later", the account simply waits on its obligations.
3. **Cancellation requests.** For each ongoing bet the app creates a cancellation request to the counterparty (a new `bet_cancel_requests` table: bet id, requested_by, created_at, response `pending|accepted|refused`, responded_at). `awaiting_guess` bets that the user created can simply be cancelled with the existing `/api/bets/:id/cancel`, no request needed. The counterparty gets an email (verified addresses only; same `sendMail` pattern as `reminders.ts`) and an in-app prompt: "Matti wants to delete their account and asks to cancel this bet. Accept or refuse." Reminder emails at day 7 and day 23.
4. **Counterparty responds:**
   - **Accepts:** the bet becomes `cancelled` (existing status, no balance impact) and no longer holds up deletion.
   - **Refuses:** the bet stays ongoing and keeps holding up deletion. The counterparty's explicit refusal is a response, and their interest in the bet wins until it is settled or they change their mind for as long as the bet is ongoing. A refusal never expires.
   - **Does not respond within 30 days** of the request: the request lapses and the bet is **force-cancelled by default**, to let erasure proceed.
   - Independently, the bet can be settled the normal way (propose/confirm/tie/not-happened) at any time.
5. **Deletion trigger.** Whenever a bet leaves the ongoing set (settled, cancelled, accepted, lapsed), the system checks the requester: if no ongoing bet remains, deletion runs right away ("delete immediately when we can"). A daily step in `/api/cron` (which already exists) lapses requests older than 30 days and runs the check.
6. **Final re-check.** The deletion transaction re-verifies that there are no ongoing bets and aborts if one slipped in; the cron retries.
7. **Notification afterwards.** The user is emailed that the deletion completed. Counterparties whose bets were force-cancelled get an email saying the bet was cancelled because they did not respond within 30 days.

**Every bettor has a verified email (decided prerequisite).** Today `requireVerifiedEmail` in `app.ts` locks accounts out of bets only when they have an email that is unverified; an account with *no* email at all is exempt, because it can never verify. For this flow to work, that exemption has to go: nobody may take part in a bet without a verified address, so a cancellation request always has somewhere to land and "no response in 30 days" is never caused by an unreachable counterparty. Existing accounts with no email (username/password, Microsoft and Apple sign-ins that returned none; Google accounts always have a verified one) must add and verify an address before they can use friends, invitations or bets again. That is the same `403 email_not_verified` path unverified accounts already hit, with the UI prompting for an address. To keep the 30-day default fair, ship this change first and give those users a notice period before the deletion feature goes live (section 14, step 0), so nobody is unreachable when a cancellation request arrives.

**A later erasure request by the counterparty.** A refusal answers one request only. Requests are keyed by `(bet_id, requested_by)`, so if the person who refused later requests their own erasure, that triggers a fresh request to each of *their* counterparties for every bet still ongoing, including the bet they once refused, and the same accept/refuse/30-day rules apply to it. When both people on a bet are in "deletion requested", each one's request is also a prompt to the other; the UI should offer a one-click accept, and the bet is cancelled as soon as either accepts.

Legal footing: erasure is not absolute. Art. 17(3)(e) lets the controller keep data needed for the establishment, exercise or defence of legal claims, and processing that is necessary to perform a contract (Art. 6(1)(b)) does not stop being necessary because one party asks to be forgotten. This is the same reason closing a bank account does not cancel the loan. An open bet is a (very informal) agreement between two people, and the other participant has a legitimate interest in it being honoured or properly closed, not erased out from under them. Caveat: a friendly bet whose stake is a "lonkero" tally is unlikely to be legally enforceable, so we should not rely on 17(3)(e) formally; the stronger argument is simply the counterparty's interest and fairness, which the privacy policy should state. Once the bet is settled or cancelled, that justification ends and erasure proceeds as in section 5. The 30-day default treats a counterparty who never responds as not asserting that interest; it is a balance between their interest and the erasing user's right to timely erasure, which is why it needs the notice and reminders described in the flow.

Known risks, to be accepted explicitly:

1. **Timing against GDPR.** Art. 12(3) wants erasure within one month, extendable by two further months for complex or numerous requests with notice to the user. The 30-day default fits this only if the 30 days run from the request date and the user is told up front. A refusal by the counterparty can extend it beyond that, on the basis above; the user should be told this plainly in the UI and given the support contact (section 12a).
2. **Personal data lingers during the wait.** The account's data still exists while the request is pending. Mitigation: the account is in a restricted mode (no new bets or invitations), and the doc/privacy policy states the reason and the maximum wait.
3. **No dodging.** Deletion cannot be used to escape a lost bet: ongoing bets either finish, are cancelled with the counterparty's consent, or are cancelled after the counterparty ignores the request for 30 days. Settled results and balances survive as anonymized records.
4. **Abuse by silence.** A user who wants out of a bet could request deletion and hope the counterparty ignores the emails. Accepting that: the cancelled bet carries no result, and the counterparty has two reminders and 30 days to act.

## 7. Confirmation UX

Account deletion is irreversible, so friction is appropriate but must not be a dark pattern (GDPR requires erasure to be about as easy as signing up):

- **Re-authentication.** Require the password (password logins), or a fresh provider sign-in (Google/Apple), within the last few minutes. Sessions are long-lived JWTs (`SESSION_DAYS`), so "signed in" is not proof the person at the keyboard is the owner. The merge feature already has a pattern for re-proving a login (`/api/merge/password` + a short-lived signed ticket); reuse the idea with a `delete` ticket.
- **Typed confirmation.** The user types their email or the word `DELETE`. One cheap guard against mis-taps, especially on mobile.
- **Plain summary before confirming:** how many friends, bets (by status) and what the other side will see.
- **No cooling-off period (decided).** Deletion happens immediately when it can, i.e. when no ongoing bets remain. The "deletion requested" wait in section 6 exists because of the bets, not as a grace period, and the user may withdraw the request while it is pending. Consequence: once the transaction runs there is no undo, which is why the re-auth and typed confirmation matter.
- **Confirmation email** after deletion to the primary verified email, which is the *last* use of that address and is not logged.

## 8. Invitations pointing at the deleted email

- Invitations *sent by* the user: deleted (the `inviter_id` is gone, and the invitee's email is a third party's data we no longer have a reason to keep).
- Invitations *to* any of the user's addresses (`invitations.email`, matched case-insensitively): deleted regardless of status, including pending ones from other people. Otherwise the deleted person's email address stays in other people's invitation lists. Inviters see the invitation disappear; this is acceptable, and the same thing already happens implicitly when an invitee accepts or declines.
- Edge: someone re-registers the same email later. That is a brand-new account with no history, which is correct. Because nothing is kept per email, a later inviter's *new* invitation works normally.
- Pending invitations tokens (`/api/invitations/token/:token`) stop resolving once the row is gone.

## 9. Interaction with merge accounts

Merging (`merge.ts`) moves B's data into A and deletes B, with a transaction. Relevant overlaps:

- **Deleting a merged account** has to cover all `identities`, all `user_emails` and all `password_credentials` the merge accumulated. The deletion must collect `subject`s from `identities` (not from `users.email`), or a password hash for a merged-in login would be orphaned. This is the main bug risk and needs a test.
- **Merge itself deletes bets between A and B** (they would be bets with yourself). That is a precedent for hard-deleting bets, but there both parties are the same person, so it does not argue for option A here.
- **Race:** an in-flight merge ticket (`merge` cookie, `MERGE_MINUTES` long) naming a user being deleted. `/api/merge/preview` already answers "That account no longer exists" and `confirm` re-checks; the deletion transaction should not need to touch the cookie. Do add a test: delete B while a ticket for (A, B) is live.
- **Reuse:** extract the "delete everything belonging to user X" statements into one helper that merge's final `DELETE FROM users WHERE id = b` block and the new deletion both use, so the two cannot drift when a table is added. Today merge deletes `avatars`, `user_emails`, `connections` and `email_verifications` for B individually.
- **Placeholders vs. merge:** merging must never treat a placeholder (`deleted_at` set) as a mergeable account. It has no identities so it cannot be logged into; confirm in tests.

## 10. Data export before deletion

Art. 20 (portability) is adjacent, and exporting just before an irreversible delete is good UX.

- Offer "Download my data" as a step in the flow and also standalone on the Profile page.
- JSON containing: profile (name, emails, avatar as a data URI), friends (display names), bets with the user (question, own guess, outcome, stake, dates, counterparty display name), invitations sent. Excludes password hashes and other people's emails.
- Generated on demand from the same queries the app already runs (`loadBets`, `/api/friends`); no stored file, so nothing new to delete.
- Never block deletion on the user having downloaded it.

## 11. Backups

There are currently **no backups**, so there is no retention window to document and no deletion ledger to maintain: once the transaction commits, the data is gone. The privacy policy should say so plainly. If backups are ever introduced, revisit this section: GDPR tolerates backups that age out quickly and are never used to restore single records, but a restore would need to replay deletions, which means keeping a minimal record (an opaque id and a timestamp, never an email) of who was erased.

## 12. Logging without retaining personal data

- Log an **audit event** at deletion: timestamp, the opaque user id, counts (bets anonymized, bets deleted, invitations removed). No email, no name, no IP.
- Do not log the request body of the deletion call. `console.error(err)` in `app.ts` could include row data on failures; the deletion path should catch and log a generic message plus the opaque id.
- Do not keep the confirmation email's recipient in any mail log we control; third-party mail provider logs fall under that provider's retention (list it in the privacy policy).
- Existing server logs that include emails (for example sign-in failures) should be checked as part of the implementation, since "deleted" means deleted from logs within their retention too.

## 12a. Support contact for stuck requests

The maintainer's address is not shown anywhere on the site (spam) and is deliberately not written into this repository either. Instead:

- A `SUPPORT_EMAIL` environment variable (next to the other settings in `server/env.ts`) holds the address; it is never rendered into HTML, returned from the API or committed.
- In the pending-deletion banner, a "Contact us about this" form. It is authenticated, so it can attach the account's verified email as the reply address, and it sends to `SUPPORT_EMAIL` through the existing `sendMail`.
- No public contact form for now (decided). People who cannot sign in at all are outside the in-app route; the privacy policy should say how to reach the maintainer without publishing the address (for example, by asking the person who runs the instance), and this is revisited if it proves insufficient.
- Replies come from the maintainer by hand; no automation.

## 13. Recommendation

1. **Immediate, self-service deletion** from the Profile page, behind re-authentication and a typed confirmation, with a prior optional data export. If ongoing bets exist, deletion happens as soon as they are cleared (section 6).
2. **Hard-delete** all identity and credential data (section 4) in a single transaction.
3. **Bets: option D.** Settled bets are anonymized to a "Deleted user" placeholder with the deleted user's guess removed; cancelled bets are deleted; **ongoing bets are cancelled by asking the counterparty; a refusal keeps the bet alive, and 30 days of silence lets erasure proceed by default**.
4. **One placeholder per deletion**, so per-person history and balances keep working for the other participant; `question` text is kept; the other participant can remove such bets from their own history.
5. No cooling-off period. Every bettor must have a verified email, which is a prerequisite change.
6. A support contact exists for users stuck pending, delivered through a form so the address is never shown (section 12a).

## 14. Implementation outline

0. **Prerequisite:** require a verified email for friends, invitations and bets for every account, removing the no-email exemption in `requireVerifiedEmail`. Existing no-email accounts (not Google ones) must add and verify an email; announce it and allow a notice period before the later steps ship.
1. **Placeholder users.** Add `users.deleted_at`. At deletion, create a fresh placeholder row (random id, name `Deleted user`, `email NULL`, no identities, `deleted_at` set) and re-point the bets and connections at it. Exclude placeholders from merge and invitation lookups and from `areConnected` for new bets. Add a test that no route lets anyone act as one.
2. **Shared deletion helper** (`server/deleteUser.ts`) that takes a user id and a list of statements, used by both deletion and merge's cleanup. Runs in one `db.batch(..., 'write')`.
3. **Schema:** `users.deletion_requested_at` (nullable) and a `bet_cancel_requests` table (section 6). Add both in `db.ts` `schema`/`migrate`.
3b. **Pre-flight endpoint** `GET /api/me/deletion-preview`: counts of friends and of bets by status, list of ongoing bets and the cancellation-request state of each.
4. **Re-auth ticket**: `POST /api/me/deletion/reauth` (password or provider re-sign-in) that issues a short-lived signed cookie, modelled on `issueMergeTicket`.
5. **Delete endpoint** `DELETE /api/me` requiring the ticket and a typed confirmation. If no ongoing bets: run the deletion now (gather identity `subject`s, transaction, clear the `session` cookie). Otherwise: set `deletion_requested_at`, create the cancellation requests, send the emails, and return "pending". `DELETE /api/me/deletion` withdraws a pending request.
5b. **Counterparty endpoints:** `POST /api/bets/:id/cancel-request/accept` and `/refuse`. Accepting sets the bet to `cancelled` and triggers the deletion check for the requester.
5c. **Restricted mode:** reject creating bets and invitations by or with an account that has `deletion_requested_at` set.
5d. **Cron:** extend `runCron` to send the day-7 and day-23 reminders, lapse requests older than 30 days (force-cancel those bets), and run the deletion check for every account with `deletion_requested_at`. Use the same claim-before-send idea as `bet_reminders` so overlapping runs cannot double-send.
6. **Transaction contents:** assert no ongoing bets (abort and retry later otherwise); delete `bet_cancel_requests` involving the user; delete cancelled bets and their `bet_reminders`; rewrite `creator_id`/`opponent_id`/`winner_id`/`outcome_proposed_by` to the sentinel and null the deleted party's guess on settled bets; delete rows listed in section 4; delete the user.
7. **Export endpoint** `GET /api/me/export` (JSON download).
8. **UI:** Profile page "Delete my account" in a danger zone; dialog with summary, export link, ongoing-bets list, re-auth, typed confirmation; a "deletion pending" banner with per-bet status and a withdraw button; counterparty prompt to accept or refuse; post-deletion landing page.
9. **Display:** wherever a user name is rendered for a bet opponent, handle placeholders ("Deleted user", generic avatar, no profile link; they otherwise appear in the friends list with a normal balance). `/api/users/:id/avatar` must 404 for them. Add `POST /api/bets/:id/remove-from-history` (only when the other participant is a placeholder; deletes the bet and cleans up an orphaned placeholder).
9b. **Support contact:** see section 12a.
10. **Tests (vitest, `server/api.test.ts` style):** every personal-data table is empty for the user afterwards (including merged accounts); the other participant's settled bets and balance are unchanged; deletion stays pending while a bet is ongoing and runs automatically once the last one is settled, cancelled or accepted; a refusal keeps it pending; a request with no response for 30 days (use an injectable clock like `runCron(now)`) force-cancels the bet and deletes the account; a request is withdrawable; a pending account cannot create bets; invitations by and to the user are gone; old session cookie gets 401; a live merge ticket for the deleted user fails gracefully; no email or name survives anywhere (a full-table scan test that searches for the deleted address).
11. **Docs:** privacy policy section on retention, the absence of backups, what other users still see, and the 30-day cancellation-request rule.

## 15. Open questions for the maintainer

None outstanding: every question raised during review has been decided and is reflected in the sections above. Likely to surface during implementation: how Apple "hide my email" relay addresses should count as a verified email, and the exact notice period for the verified-email requirement.
