# Authentication and browser storage

State of the code as of `main` at commit `9f5a039`. Everything below was read from `server/auth.ts`, `server/app.ts`,
`server/merge.ts`, `server/env.ts`, `server/verification.ts`, `src/api.ts`, `src/pages/Login.tsx` and friends.
Section 7 onwards is assessment and recommendation; sections 1–6 are description only.

> ## ⚠️ Findings that deserve attention first
>
> 1. **DOM XSS / open redirect via `?next=` on the login page** (`src/pages/Login.tsx:10,37,78`). `next` is read straight
>    from the URL and assigned to `location.href` after a successful password or dev login, with no validation. A link to
>    `/login?next=javascript:…` runs attacker script in the app's origin once the victim signs in (the session cookie is
>    HttpOnly, so it cannot be read, but the script can call the API as the user). `?next=https://evil.example` is a
>    post-login open redirect usable for phishing. The server-side OAuth path *does* sanitise (`safeNext` in
>    `server/auth.ts:212`); the client-side path does not. **Fix:** reuse the same rule (`/^\/(?![/\\])/`) on the client.
> 2. **No server-side revocation, and no password change/reset.** A session JWT is valid for 30 days no matter what.
>    "Log out" only deletes the cookie in that browser; a copied cookie keeps working. There is nothing to click after a
>    lost device or a suspected compromise. (Details in §7.)
> 3. **No rate limiting anywhere** — `/api/auth/login`, `/register`, `/merge/password` (a password oracle for *any*
>    account, once signed in) and `/verify-email` are unlimited.
>
> Nothing here is exploitable without user interaction or a stolen cookie, and I did not find an unauthenticated account
> takeover. Findings 1 and 3 are real bugs/risks; the rest of the list in §8 is graded individually.

## 1. Browser storage inventory

**The client uses no `localStorage`, `sessionStorage`, IndexedDB, Cache API or service worker.** I grepped `src/`,
`index.html` and `public/`; there are no hits. `public/manifest.webmanifest` makes the app installable as a PWA but
registers no service worker. The only persistent browser state is the three cookies below. The client never reads
cookies (`document.cookie` is unused; they are HttpOnly) and `src/api.ts` just calls `fetch(..., { credentials: 'same-origin' })`.

All cookies are set by the Express server (`res.cookie`), are **host-only** (no `Domain` attribute), `Path=/`, `HttpOnly`,
and `Secure` only when `env.isProd` (`NODE_ENV=production` or running on Vercel). Because they are host-only and the app
and API share one origin (Vercel rewrites `/api/*` to the Express function), there is no cross-origin cookie handling.

| Cookie | Purpose | Contents | Lifetime | SameSite | Set by | Cleared by |
|---|---|---|---|---|---|---|
| `session` | The login | HS256 JWT: `sub` = user id, `iat`, `exp` | 30 days, fixed. Cookie `Max-Age` and JWT `exp` both 30 d; never renewed | `Lax` | `startSession` after password login, register, dev login or OAuth callback | `POST /api/auth/logout` |
| `oauth` | OAuth/OIDC flow state between redirect and callback | HS256 JWT: `state`, `nonce`, `next`, optional `merge` (user id of account A), `exp` | 10 min | `Lax`; **`None` for Apple in production** (Apple's `form_post` callback is a cross-site POST) | `GET /api/auth/:provider` | Callback (`handleCallback`), before the state check |
| `merge` | Account-merge ticket | HS256 JWT: `a` (signed-in account), `b` (account whose login was proven), `exp` | 10 min | `Lax` | `issueMergeTicket` (merge password/dev step, or OAuth callback in merge mode) | `/api/merge/confirm`, `DELETE /api/merge`, or when it names a different user than the session |

Flags that are **not** set: no `__Host-`/`__Secure-` prefix, no `Partitioned`, no `Priority`. In development `Secure` is
off so `http://localhost` works. Cookie names are plain `session`, `oauth`, `merge`.

No cookie is signed with cookie-parser's signing; integrity comes from the JWT signature. `cookieParser()` is called
without a secret.

## 2. Session JWTs (jose)

- **Signing:** `SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setExpirationTime('30d')`,
  signed with `SESSION_SECRET` (`server/env.ts`).
- **Secret handling:** in production (`NODE_ENV=production` or `VERCEL`) the server refuses to start without
  `SESSION_SECRET`. Outside production it silently falls back to the hard-coded string
  `dev-only-secret-do-not-use-in-production`. There is no minimum-length/entropy check.
- **Verification:** `readSessionUser` calls `jwtVerify(token, secret, { algorithms: ['HS256'] })` (signature + `exp`; no
  `iss`/`aud` check), then **looks the user up in the database on every request**. A deleted account (e.g. the "B"
  side of a merge) therefore stops working immediately. Any error → treated as signed out. `requireAuth` guards all
  `/api` routes registered after `app.use('/api', requireAuth)` in `server/app.ts`.
- **One key, three token types.** The session, `oauth` and `merge` JWTs share the same secret and have no `typ`/`aud`
  claim separating them. They are currently told apart only by claim shape (`sub` vs `state/nonce` vs `a/b`), which holds
  today but is fragile (see §8, item N3).
- **Expiry behaviour:** hard 30-day cut-off from the *last login*, however active the user is. After day 30 every
  request returns 401 and the user must sign in again.
- **Rotation:** none. Changing `SESSION_SECRET` logs everybody out (and invalidates in-flight `oauth`/`merge` cookies);
  there is no `kid`, so there is no graceful rotation.

## 3. Login methods

### 3.1 Password (`POST /api/auth/register`, `/login`)
- Input: `email` + `password` (zod: valid email, 8–200 chars). No other password policy.
- Hashing: Node `scrypt` with Node's defaults (N=16384, r=8, p=1), 16-byte random salt, 64-byte output, stored as
  `salt:hash` in `password_credentials`. Comparison uses `timingSafeEqual`.
- Unknown email: login verifies against a precomputed dummy hash, so response time does not reveal which emails exist.
  Wrong email and wrong password return the same 401 message.
- Registration returns **409 "already registered"** for existing emails (an enumeration oracle; intentional UX).
- Registered emails start **unverified**. Password-account emails are never used to link or match other accounts.
  A verification mail is sent best-effort; token = 32 random bytes, only its SHA-256 is stored, valid 24 h, resend
  cooldown 60 s per user.
- Both endpoints start a session (`session` cookie). There is no "forgot password" and no "change password" endpoint.

### 3.2 OAuth/OIDC: Google, Microsoft, Apple (`GET /api/auth/:provider` → `…/callback`)
Authorization-code flow with a confidential client (client secret; Apple's secret is an ES256 JWT minted per request).

1. **Start:** server generates `state` and `nonce` (16 random bytes, hex each) and `next` (sanitised by `safeNext`:
   must start with a single `/`), puts them in the signed `oauth` cookie (10 min) and redirects to the provider with
   `redirect_uri = ${APP_URL}/api/auth/<provider>/callback`, `response_type=code`, `scope`, `state`, `nonce`.
   Apple additionally uses `response_mode=form_post`. In production, a localhost `APP_URL` is rejected up front.
2. **Callback** (GET for Google/Microsoft, POST for Apple, handled by the same function): verifies the `oauth` cookie
   signature, clears it, requires `params.state === flow.state`, exchanges `code` for tokens, verifies the `id_token`
   against the provider's remote JWKS (`audience` = client id; `issuer` for Google and Apple), and checks
   `payload.nonce === flow.nonce`.
3. **Identity mapping:** `findOrCreateUser` keys on `(provider, sub)`. Only if the provider's email is trusted
   (Google/Apple `email_verified`; **never Microsoft**, see the nOAuth comment in code) does it link a new identity to
   an existing user with that *verified* email. Untrusted-email providers get a verification mail on first sign-in.
4. **Finish:** `startSession`, redirect to `APP_URL + safeNext(flow.next)`. Failures redirect to
   `/login?error=<message>`.

What is **not** there: **no PKCE** (`code_challenge`/`code_verifier`), no `max_age`/`prompt`, no check of `at_hash`
(no access token is used), and the Microsoft config has no `issuer` (with tenant `common` the issuer varies by tenant, so
the `iss` claim is not validated at all for Microsoft). State is bound to the browser by the signed cookie, which is the
standard stateless-state pattern and stops login CSRF.

### 3.3 Dev login (`POST /api/auth/dev`, `/api/merge/dev`)
Signs in (or creates) **any email without any credential**, with `emailVerified: true` and `linkByEmail: true`, so it
attaches to an existing account having that verified email. Enabled only when `!isProd` **and** (local file/in-memory DB
and `DEV_LOGIN !== 'off'`, or remote DB and `DEV_LOGIN === 'on'`). Returns 404 otherwise. `GET /api/config` exposes
`devLogin` so the UI can show the form.

## 4. Account merge flow (`server/merge.ts`)

Merge account B into signed-in account A.

1. **Prove B.** `POST /api/merge/password` (B's email+password), `POST /api/merge/dev`, or an OAuth flow started with
   `?merge=1` (requires a valid session; A's id is stored in the `oauth` cookie because Apple's cross-site POST
   callback would not carry `session`). The result is a **`merge` ticket cookie** `{a, b}` (10 min, HttpOnly, Lax). The
   session is never replaced.
2. **Preview.** `GET /api/merge/preview` / `avatar/:side` require session **and** a ticket with `a === session user`.
3. **Confirm.** `POST /api/merge/confirm` re-validates: both accounts' primary emails verified, no unfinished bets
   between them, a new password supplied if both have password logins. One DB transaction moves bets, friends,
   invitations, identities, emails and avatar to A and deletes B; then the ticket is cleared.

Properties: the ticket needs both the live session of A and proof of B's credentials; it is bound to `a`, not to a
particular session. It is not single-use at the token level (a replay within 10 min fails because B no longer exists).
Confirm does not ask for A's password again.

## 5. CSRF posture

- **Primary defence: `SameSite=Lax` on all cookies** (Apple's `oauth` cookie excepted — it grants nothing by itself and
  is useless without a matching `state` and a provider-issued code).
- **No CORS headers** are sent. JSON bodies with `Content-Type: application/json` need a preflight cross-origin and are
  blocked. `fetch` sends cookies only for `same-origin`.
- **State-changing routes are POST/PUT/DELETE**; the only GETs with side effects are `/api/auth/:provider` (sets the flow
  cookie) and `/api/cron` (bearer-secret protected). Good.
- **Gap:** `express.urlencoded()` is enabled globally (for Apple), so every POST route also accepts a plain HTML form
  body. Today `Lax` stops cross-site form posts from carrying the cookie, so this is only defence in depth, but there is
  no `Origin`/`Sec-Fetch-Site` check and no CSRF token.
- **Login CSRF** is blocked by `state` + the `oauth` cookie. Password login has no CSRF token, but an attacker gains
  nothing from forcing a login into an account they already know the password of except the classic "victim uses
  attacker's account" confusion; low risk.
- **Clickjacking / headers:** the server sets no `X-Frame-Options`/`frame-ancestors`, no CSP, no `nosniff`, no
  `Referrer-Policy`. (Vercel adds HSTS on its own domains; verify for custom domains.) `Lax` cookies still travel on
  framed same-site requests, so UI clicks on bet actions are frameable.

## 6. Other relevant behaviour

- All authenticated routes hit the DB for the user on every request (cheap with libsql/Turso, and it is what makes
  user deletion an effective kill-switch).
- Errors from providers in the callback are reflected into `/login?error=…` and rendered as React text
  (`Login.tsx:30`): no HTML injection, but anyone can craft a link that shows arbitrary text on the login page
  (content spoofing/phishing aid). Low.
- `express` `trust proxy` is not configured, so `req.ip` is the Vercel proxy address — relevant when adding IP-based rate limits.
- Invitation links `…/invite/<token>` and verification links `…/verify-email?token=` carry bearer tokens in URLs; the
  verification token is hashed at rest, the invite token is stored raw and returned to the inviter.

---

## 7. Assessment: long-lived logins without being relaxed

**Goal:** a friend-betting app people open from a phone every few days should *not* ask for a password again for months,
yet a stolen cookie, a lost phone, or a compromised account must be containable.

### What is already good
- HttpOnly cookies, nothing in JS-readable storage — XSS cannot exfiltrate the session token (though it can still *use* the session).
- `SameSite=Lax` + no CORS + non-GET mutations: solid baseline CSRF posture.
- JWT algorithm pinned to HS256; production refuses to boot without `SESSION_SECRET`.
- DB lookup on each request → deleted/merged accounts die instantly.
- OAuth done properly in the essentials: `state` in a signed short-lived cookie, `nonce` verified, ID-token signature, audience and (Google/Apple) issuer verified, `safeNext` against open redirects server-side, Apple's cross-site cookie handled deliberately.
- Careful email trust model (no linking on Microsoft/password emails; merge requires verified emails on both sides), constant-time-ish password login, hashed verification tokens, hashed passwords with a memory-hard KDF.
- `redirect_uri` guard against localhost in production.

### Gaps against the goal
The problem is the *shape* of the session: a **fixed 30-day, non-renewing, non-revocable bearer**. That is simultaneously
too strict for active users (forced re-login every 30 days despite daily use — friction) and too lax for compromise
(a stolen cookie is good for up to 30 days; logout, merge and any future password change cannot cut it off).

### Recommendation

**Session model: server-side sessions table, opaque/rotating token — or a JWT that carries a `sid`.** Keep jose if you
like, but make the cookie a reference to a row:

```
sessions(id, user_id, created_at, last_used_at, expires_at, absolute_expires_at, user_agent, ip_hint, revoked_at, token_hash)
```

| Decision | Recommendation | Trade-off |
|---|---|---|
| **Idle (sliding) lifetime** | 30 days idle. Extend `expires_at` on use, but write to the DB at most once per day (or when <50 % of the window is left) to avoid a write per request. | Longer idle = more convenience, longer exposure of a stolen cookie. |
| **Absolute maximum** | 180 days (or 365 for a low-stakes app) from original login, then a normal sign-in. | Forces a periodic login even for daily users; limits the lifetime of any leaked token and of a forgotten device. With OAuth login this is one tap. |
| **Rotation** | Re-issue the token on renewal (e.g. once a day) and on any privilege change (login, password change, merge). Keep the previous token valid for ~60 s so parallel requests/tabs don't race. Detect reuse of an old token after the grace period → revoke that session family. | Adds complexity and a small race window; the payoff is that a copied cookie stops working the next time the real user shows up (or trips the alarm). |
| **Revocation / "log out everywhere"** | Logout deletes/revokes the server row (not just the cookie). Add a "Signed-in devices" list on the profile page with per-session revoke + "log out everywhere". Revoke all other sessions on password change/set, and after a merge. | Needs the table and one lookup per request — which the code already does for the user row, so it is nearly free. A cheaper stopgap: a `users.session_version` integer put in the JWT and compared on each request; bump it to revoke all sessions at once (no per-device list). |
| **Cookie flags** | Keep `HttpOnly; Secure; SameSite=Lax; Path=/`, host-only. Rename to **`__Host-session`** (requires `Secure`, `Path=/`, no `Domain`; the code already satisfies this in production). Always set `Secure` outside localhost rather than keying only on `isProd`. Keep `Lax` (not `Strict`): `Strict` would drop the session on links from email/chat and the OAuth return. | `__Host-` cookies are rejected over plain HTTP, so dev needs an unprefixed name (`isProd ? '__Host-session' : 'session'`). Renaming logs everyone out once — do it together with the migration to server sessions. |
| **Flow cookies** | `oauth` and `merge`: also `__Host-` prefixed (`__Host-` works with `SameSite=None; Secure` for Apple). Keep ≤10 min. Add `typ` or `aud` claims to every JWT so a token of one kind can never be replayed as another. | Trivial. |
| **CSRF** | Keep `SameSite=Lax`, **add a middleware that rejects non-GET requests when `Origin` (or `Sec-Fetch-Site`) is not same-origin**, and require `Content-Type: application/json` on everything except the Apple callback (mount `urlencoded` only on that route). Optionally send `X-Frame-Options: DENY`/`frame-ancestors 'none'`. | A few lines; no token plumbing needed for a same-origin SPA. Do not rely on `Lax` alone — it is a browser behaviour, not a server guarantee. |
| **Login rate limiting** | Per-IP *and* per-account-email limits on `/login`, `/register`, `/merge/password`, `/verify-email`, resend-verification: e.g. 5 failures / 15 min / (email), 20 / 15 min / IP, with exponential back-off, plus a small constant delay. Needs `app.set('trust proxy', …)` on Vercel and a shared store (Turso table or Upstash/Vercel KV) because serverless instances share no memory. Don't hard-lock accounts (lets attackers lock out victims); throttle instead. | Without a shared store an in-memory limiter is nearly useless on Vercel. Per-IP limits hurt shared NATs slightly. |
| **Re-authentication for sensitive actions** | Require a **recent authentication** (e.g. ≤10 min, tracked as `auth_at` on the session) for: changing primary email, removing an email/login method, setting/changing password, confirming a merge, and any future account deletion. Satisfy it with the password, or a fresh OAuth round-trip (`prompt=login`/`max_age=0`) for social-only users. | Adds a step on rare actions only — cheap relative to the protection against a stolen long-lived session being used to take over the account permanently. Merge already requires proving B; also require re-proving A. |
| **Account recovery** | Add password reset by emailed one-time link (hashed token, 30–60 min, single-use) and revoke all sessions when it completes. | Needs email delivery to be configured in production. |
| **Sign-in alerts** | Optional: email "new sign-in" and "password changed". | Nice, cheap once mail works. |

Net effect for users: active people stay logged in effectively forever (idle window renews; absolute cap only every
~6 months), while a leaked or forgotten session dies within a day of the real user's next visit, can be revoked on
demand, and cannot change security-relevant settings without a fresh login.

**Minimal viable path** if you want the smallest change that delivers most value:
(1) fix the `next` bug; (2) add `users.session_version` + sliding re-issue of the JWT (reuse the existing code; add
`iat`-based "renew when older than 1 day"; absolute cap via an `auth_time` claim); (3) revoke on logout-everywhere,
password set and merge; (4) rate-limit; (5) Origin check; (6) recent-auth for merge/email changes. Per-device
sessions can come later.

## 8. Findings, graded

**Real bugs / risks**

| # | Finding | Where | Severity |
|---|---|---|---|
| R1 | Unvalidated `?next=` assigned to `location.href` → `javascript:` DOM XSS after login; open redirect to any site | `src/pages/Login.tsx:10,37,78` | **High-ish** (needs a victim to click a crafted link and log in) |
| R2 | Sessions cannot be revoked; logout is client-side only; merge/credential changes don't invalidate other sessions; 30-day window | `server/auth.ts:87-113,288` | **Medium** |
| R3 | No rate limiting on password endpoints (login, register, `/merge/password`, `/verify-email`) | `server/auth.ts`, `server/merge.ts` | **Medium** |
| R4 | Dev login is gated by `!isProd`, and `isProd` is only `NODE_ENV=production` or `VERCEL`. A non-Vercel deployment started without `NODE_ENV=production` and with a local DB would expose passwordless sign-in as any email **and** run with the public fallback `SESSION_SECRET` (forgeable sessions). Pointing a dev server with `DEV_LOGIN=on` at a real remote DB lets anyone take over any account with a verified email (dev login links by email). | `server/env.ts` | **Medium** (config-dependent). Fail closed: also require a loopback bind/host, and refuse the fallback secret unless the DB is local. |
| R5 | Microsoft `iss` not validated (no `issuer`, tenant `common`); identity keyed on `sub` only. Prefer validating `iss` against the token's `tid` and keying on `tid`+`sub` (or `oid`). | `server/auth.ts:42-51,356` | Low–medium |
| R6 | Email squatting: anyone can register a password account with a victim's address (unverified, no mail needed); the real owner then gets "already registered" and can never use that address for password sign-up (Google/Apple sign-in still works and creates a separate account because only *verified* addresses are linked). | `server/auth.ts:240-260` | Low–medium. Mitigate: allow a verified owner to take over an unverified registration, or require verification before the password login becomes usable. |
| R7 | No password reset / change; users who forget a password are stuck, and there is no way to rotate a leaked one. | — | Medium (functional gap with security impact) |
| R8 | `/api/auth/:provider/callback` reflects any `error` query value into the login page text (spoofing). | `server/auth.ts:336` | Low |

**Nice-to-haves**

| # | Item |
|---|---|
| N1 | PKCE (`S256`) on the code flow — redundant with `nonce` for ID-token logins, but recommended by OAuth 2.1/BCP and cheap. |
| N2 | Security headers: CSP, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy` (note: tokens in `?token=` URLs). |
| N3 | `typ`/`aud` claims per token kind, `iss` claim, `kid` for secret rotation; minimum-length check on `SESSION_SECRET` (≥32 bytes). |
| N4 | Raise scrypt cost (e.g. N=2^17) and store the parameters in the hash string so they can be upgraded on login; consider checking passwords against a breached list. |
| N5 | Make the merge ticket single-use and bound to the session/`sid`; recent-auth on confirm. |
| N6 | Constant-time comparison for `CRON_SECRET`; hash invitation tokens at rest like verification tokens. |
| N7 | Registration enumeration (409): acceptable UX trade-off, but pair with rate limiting. |
| N8 | `trust proxy` setting for correct client IPs. |

## 9. Suggested order of work

1. Fix R1 (client `next` validation) — a 3-line change, ship immediately.
2. Rate limiting (R3) with a shared store, plus Origin check (CSRF defence in depth).
3. Session overhaul: sliding renewal + absolute cap + revocation (`session_version` or sessions table), `__Host-` prefix, token `typ`.
4. Password reset (R7), recent-auth gate for email/password/merge changes.
5. Tighten dev-login/secret gating (R4), Microsoft issuer/tenant (R5), squatting (R6), headers/PKCE.
