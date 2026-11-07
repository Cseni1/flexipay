# Platform tracker

Tracks the engineering recommendations from the 7 Nov 2026 audit: testing, CI, monitoring, reuse of
off-the-shelf tools, and dead code. Each item has a status, an owner, and, where the founder must act
(accounts, keys, dashboards), step-by-step instructions.

Status legend: ✅ done · 🟡 in progress · ⏳ planned · 🙋 waiting on the founder · ⏸ deferred

Last updated: 7 Nov 2026.

## 1. Testing and CI

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | CI on every PR (`.github/workflows/ci.yml`) | ✅ | Types, lint, config, unit + API tests on real Postgres, coverage floors, OpenAPI drift, migration drift, build, dependency audit, Playwright e2e-ui, Soroban contract `cargo test`, gitleaks. PR #186. |
| 1.2 | Coverage floors (only go up) | ✅ | API 85%, web 55%, Stellar 80%, Solana 98%, domain 80%, live adapters 85%, sim 90%. |
| 1.3 | Nightly live check (`.github/workflows/nightly-live.yml`) | ✅ | 05:17 UTC daily and on demand: live read-only suite + one real sandbox payout. Uses repo secrets `FP_QA_EMAIL`, `FP_QA_PASSWORD` (set 7 Nov). |
| 1.4 | Backend tests (payment engine, refunds, poller, route permissions) | ✅ | PR #183: 73% → 87% lines, 403 tests; route permission matrix covers every route. |
| 1.5 | Web unit tests | ✅ | PR #181: 24% → 56% lines, 272 tests. |
| 1.6 | Settlement adapter tests | ✅ | PR #180: Stellar 44% → 81%, Solana 70% → 100%. |
| 1.7 | Bugs found by the audit | ✅ | Fixed in #182 and #184 (CCR-41). Open: passkey submit replay (dormant Stellar passkey feature). |
| 1.8 | Live DB matches the schema | ✅ | Missing `ClaimLink.acceptedEndpointId` index declared; read-only `prisma migrate diff` against Neon is empty. CI checks migrations vs schema on every PR. |
| 1.9 | Branch protection: require CI before merge | 🙋 | See guide G1. |
| 1.10 | Load test (many payments at once) | ⏳ | Before real money. |

## 2. Off-the-shelf tools instead of our own code

| # | Item | Status | Owner | Notes |
|---|---|---|---|---|
| 2.1 | Error monitoring: **Sentry** | 🙋 | Founder (account) | Code ready (API `src/monitoring.ts`, web `src/monitoring.ts`): off until `SENTRY_DSN` (Render) / `VITE_SENTRY_DSN` (Vercel) are set; request bodies and headers are never sent. Founder configures later: guide G2. |
| 2.2 | Uptime monitoring: **UptimeRobot** (free) | 🙋 | Founder | Guide G3. |
| 2.3 | Keep the API awake so the partner poller runs (Render free plan sleeps) | ✅ | Integrator | `.github/workflows/keep-awake.yml` pings `/healthz` every 10 minutes; partner webhooks (2.4) will become the main signal. |
| 2.4 | **Partner webhooks** (Tazapay, BlindPay) instead of polling only | ⏳ | Builder (Freebuff) | Faster status updates; poller stays as a safety net. |
| 2.5 | Durable background jobs: **pg-boss** (on our Postgres) | ⏳ | Builder | Jobs survive restarts and redeploys. |
| 2.6 | Bank detail checks: **ibantools** (IBAN/BIC format) | ✅ | Integrator | `POST /v1/endpoints` refuses a malformed IBAN or SWIFT/BIC with a message naming the field (domain `api/endpoints.ts`). Web form shows the API message. |
| 2.7 | Public API docs: **Scalar** from `openapi.json` | ✅ | Integrator | `https://flexipay-api.onrender.com/docs` (reference) and `/openapi.json` (spec), public, no key. |
| 2.8 | Solana Pay links/QR: official **@solana/pay** | ⏳ | Builder | Replace our own URL building. |
| 2.9 | Reference FX for simulated routes: **Frankfurter** (ECB, free) | ⏳ | Integrator | Only the simulated/placeholder rates; partner routes already use live partner quotes. |
| 2.10 | Outgoing customer webhooks: **Svix** | ⏸ | Later | When customers integrate events. |
| 2.11 | Double-entry ledger: **Formance** (open source) | ⏸ | Later | Before real money. |
| 2.12 | Embedded wallet: **Privy** | 🙋 | Founder (App ID) | Code merged (#178); founder will set it up later. Guide G4. |

Kept in-house on purpose (FlexiPay's value): routing and partner comparison, the payment engine (legs,
retries, refunds), quotes and fees, the Stellar payout vault.

## 3. Dead code

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Crossmint (declined 7 Nov): card checkout, onramp route, SDK, stubs | ✅ | PR #187. High-severity production audit advisories 51 → 21. |
| 3.2 | Unused web code found by knip (notification provider, old corridor helpers, `formatUsdcBalance`) | ✅ | PR #187. |
| 3.3 | Transak top-up | ⏸ | Kept for now (founder decision, 7 Nov). |
| 3.4 | Stellar passkey claim wallets, SEP-24 anchor cash-out | ⏸ | Earlier Stellar phase; decide after Demo Day. |
| 3.5 | Old Stellar demo scripts (`scripts/demo`, `tests/e2e`) | ⏸ | Archive after Demo Day. |
| 3.6 | Remaining unused exports (about 40, mostly types) | ⏳ | Low risk; clean up with a knip pass in CI. |

## 4. Step-by-step guides (founder actions)

### G1. Require CI before merging (GitHub branch protection)
1. Open https://github.com/Cseni1/flexipay/settings/branches
2. Click **Add classic branch protection rule** (or edit the rule for `main`).
3. Branch name pattern: `main`.
4. Tick **Require status checks to pass before merging**, then search and add: `checks (config, types, lint, unit + API tests with coverage, build, drift)`, `e2e-ui (Playwright, mocked API)`, `contract (Soroban payout vault, cargo test)`, `secret scan (gitleaks)`.
5. Click **Create** / **Save changes**.

### G2. Sentry (later)
1. Go to https://sentry.io/signup/ and sign up with ccpeoplesolutions@gmail.com (free Developer plan).
2. Create a project: platform **Node.js**, name `flexipay-api`. Copy its **DSN**.
3. Create a second project: platform **React**, name `flexipay-web`. Copy its **DSN**.
4. Send both DSNs to the integrator (they are not secret but keep them off public pages). The integrator sets `SENTRY_DSN` on Render and `VITE_SENTRY_DSN` on Vercel and checks that a test error arrives.

### G3. UptimeRobot (free uptime alerts)
1. Go to https://uptimerobot.com and sign up (free plan).
2. Click **New monitor** → type **HTTP(s)** → URL `https://flexipay-api.onrender.com/healthz` → interval 5 minutes → alert contact: your email → **Create monitor**.
3. Repeat for `https://my.getflexipay.app`.
4. Optional: also add `https://flexipay-console-prototype.vercel.app`.

### G4. Privy (FlexiPay wallet, later)
1. Sign in at https://dashboard.privy.io with ccpeoplesolutions@gmail.com.
2. Create an app named **FlexiPay**; copy the **App ID** from **Settings → Basics** (never the App secret).
3. Send the App ID to the integrator, who will then guide the dashboard settings (enable Solana embedded wallets, allowed origins `https://my.getflexipay.app`) and run a live login test.
