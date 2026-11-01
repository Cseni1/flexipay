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

## Approved hosting stack

| Part                | Provider | What it does for auth                                                        |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| Frontend (`apps/web`) | Vercel   | Serves the app on the **web origin**; rewrites API paths to Render (below). |
| API (`apps/api`)    | Render   | Runs Express + Better Auth; holds every secret below as server-side env.     |
| PostgreSQL          | Neon     | `DATABASE_URL`; stores users, sessions, memberships and all payment data.    |
| Transactional email | Brevo    | Verification and password-reset mail via `https://api.brevo.com/v3/smtp/email` (the endpoint is fixed in `src/auth/mailer.ts`). |

No provider account, key, URL or domain is configured by this repository. Everything in angle
brackets below is a placeholder to fill in at deployment.

## Vercel rewrites (required)

Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` (production), prefix `fp`. For `Lax` to work
the browser must see the API under the **web origin**, so the Vercel project must forward
**both** `/api/auth/*` and `/v1/*` to the Render service. This is what the local Vite proxy does
in development. The browser then only ever talks to the web origin; the Render URL is never
used by browser code, and CORS is not needed.

Shape of the rewrite (placeholder host; **not** in `vercel.json`, because the Render URL does not
exist yet and the existing catch-all `/(.*)` -> `/index.html` rewrite must stay last):

```json
{
  "rewrites": [
    { "source": "/api/auth/:path*", "destination": "https://<render-api-host>/api/auth/:path*" },
    { "source": "/v1/:path*", "destination": "https://<render-api-host>/v1/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

Consequences to check when wiring it up:

- `WEB_ORIGIN` on Render must equal the Vercel origin the browser uses (scheme + host, no path,
  `https` in production). Email links and the Origin allow-list are built from it; a mismatch makes
  every cookie-authenticated write return 403 `forbidden_origin`.
- Behind Vercel and Render the API sees a proxy chain. Set `TRUST_PROXY_HOPS` to the verified
  number of proxies in front of the API (UNKNOWN until deployed). Too few: all users share one
  rate-limit bucket. Too many: client addresses can be spoofed.
- Do not switch the session cookie to `SameSite=None` to avoid the rewrite.
- Preview deployments use a different origin: add it to `WEB_ORIGIN_EXTRA` only if you need
  sign-in there.

## Exact environment variable names

Names the code reads today (`apps/api/src/main.ts`, `apps/api/src/auth/config.ts`). Set them on the
Render service; none may appear in the Vercel project or the browser bundle.

| Variable              | Where it is read | Notes                                                              |
| --------------------- | ---------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`        | `main.ts`        | Neon connection string. Required; the API refuses to start without it. Pooled vs direct connection for migrations: UNKNOWN, decide at deployment. |
| `BETTER_AUTH_SECRET`  | `auth/config.ts` | Required in production, >= 32 characters. Generate it yourself; never commit it. |
| `WEB_ORIGIN`          | `auth/config.ts` | Required in production (the Vercel origin).                        |
| `WEB_ORIGIN_EXTRA`    | `auth/config.ts` | Optional, comma-separated extra trusted origins.                   |
| `BREVO_API_KEY`       | `auth/config.ts` | Required in production. Server-side only.                          |
| `BREVO_SENDER_EMAIL`  | `auth/config.ts` | Required together with the key; must be a sender verified in Brevo. |
| `TRUST_PROXY_HOPS`    | `main.ts`        | Number of trusted proxies; unset = socket address is used.         |
| `FP_MAIL_DEV_CONSOLE` | `auth/config.ts` | `1` prints mail to the console. Local only; refused in production. |
| `NODE_ENV`            | `auth/config.ts` | `production` enforces `https` for `WEB_ORIGIN` and secure cookies. Whether Render sets it is UNKNOWN: set it explicitly. |

If any required auth variable is missing the API still starts but logs
`customer auth DISABLED: <reason>` and serves 503 on `/api/auth/*`.

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
