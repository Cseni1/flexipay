# Customer authentication (TASK 06)

Better Auth (1.7.15, pinned) on the existing Express 5 + Prisma 7 API. Customer sessions
identify a person; server API keys (`Authorization: Bearer`) identify an organization's backend.
They are separate credentials and separate route classes.

## Route classes (`auth` field in `apps/api/src/routes.ts`)

| `auth`       | Accepts                     | Used for                                                    |
| ------------ | --------------------------- | ----------------------------------------------------------- |
| `"customer"` | API key **or** session      | recipients, endpoints, quotes, payments, batches, events, me |
| `"api_key"`  | API key only                | `/v1/sandbox/*` (admin/test controls)                       |
| `"session"`  | session only                | `/v1/api-keys*` (a leaked key cannot mint more keys)        |
| `"none"`     | nobody                      | `/healthz`, public ClaimLink routes (`/v1/claims/*`)        |

An `Authorization` header always means API-key auth; a bad key never falls back to a cookie.

## Environment (API, Render)

| Variable               | Required          | Meaning                                                                 |
| ---------------------- | ----------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`         | yes (existing)    | Postgres (Neon)                                                         |
| `BETTER_AUTH_SECRET`   | yes in production | >= 32 chars. No default. Outside production a random per-process secret is generated. |
| `WEB_ORIGIN`           | yes in production | The Vercel origin, e.g. `https://app.<your-domain>`; `https` enforced in production. Email links and the CSRF/Origin allow-list are built from it. |
| `WEB_ORIGIN_EXTRA`     | no                | Comma-separated extra trusted origins (e.g. a preview URL).             |
| `BREVO_API_KEY`        | yes in production | Brevo transactional email API key (server-side only).                   |
| `BREVO_SENDER_EMAIL`   | with the key      | Verified Brevo sender address.                                          |
| `TRUST_PROXY_HOPS`     | recommended       | Number of reverse proxies in front of the API, so rate limiting sees the real client address. Wrong value = everyone shares one rate-limit bucket (too few hops) or spoofable addresses (too many). Verify on Render. |
| `FP_MAIL_DEV_CONSOLE`  | dev only          | `1` prints emails (with one-time links) to the console. Refused in production. |

Missing or invalid auth configuration **fails closed**: the API still starts, logs
`customer auth DISABLED: <reason>`, answers 503 on `/api/auth/*` and never accepts a cookie.
API-key access is unaffected.

## Hosting shape (Vercel + Render + Neon)

Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` (production), prefix `fp`. For `Lax` to work
the browser must see the API under the **web origin**: the Vercel project must rewrite
`/api/auth/*` and `/v1/*` to the Render service (same-origin proxying), exactly as the local Vite
proxy does. The destination URL is a deployment decision and is intentionally **not** in
`vercel.json` yet (UNKNOWN until the Render service exists). Do not switch the cookie to
`SameSite=None`.

## Database

Migration `20261101130000_task06_better_auth` adds `AuthUser`, `AuthSession`, `AuthAccount`,
`AuthVerification`, `Membership` (additive; no existing table changes). It has **not** been
applied to any shared database. Apply with the normal `prisma migrate deploy` after review.

## Organization bootstrap

`ensureOrganization` creates `Organization` + `Membership` in one transaction. `Membership.userId`
is unique, so concurrent calls produce exactly one organization. It runs after user creation and
again lazily on the first session request, so a failed hook is self-healing.

## Security controls and where they are tested (`apps/api/test/auth.test.ts`)

1. Sandbox admin: `auth: "api_key"` routes refuse sessions.
2. Secret: no constant fallback; `loadAuthConfig` unit tests.
3. Logout: DB-backed sessions, no cookie cache; replay returns 401.
4. Origin/CSRF: trusted `Origin` required for cookie-authenticated mutations and for every
   non-GET `/api/auth/*` call (own gate; Better Auth's own check was observed not to reject a bad
   Origin in the test environment, so we do not rely on it).
5. Password reset: `revokeSessionsOnPasswordReset`; both sessions return 401 afterwards.
6. Rate limiting: per client address, per bucket (sign-in 10/15 min, sign-up 5/h, recovery 5/h,
   other 120/min). In-memory: single API instance. Several instances need a shared store.
7. Bootstrap: atomic and race-safe (tested with 8 concurrent calls).
8. Hosting/email: see above; Brevo errors never include the key.

## Integration point with the Solana work (not changed here)

`apps/api/src/routes/solana.ts` still declares `auth: "api_key"` on its two protected routes
(`/v1/payments/{id}/solana/intent` and `/confirm`), so a signed-in browser session cannot use them
yet. After the Solana branch (F3 to F9) merges, change those two to `auth: "customer"`. This is a
two-line change that was left out on purpose to avoid conflicting with that branch.

## Known limits

- Sign-in throttling is per client address, not per account.
- One organization per user (MVP); no invitations or roles beyond `owner`.
- The local Vite proxy forwards `/api/auth/*`; it is a development tool, not a deployed BFF.
