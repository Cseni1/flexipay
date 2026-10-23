# FlexiPay: Architecture

Version 5, 23 Oct 2026. Frozen for the build: changes only through `docs/CONTRACT_CHANGES.md`. Source of truth for all builders and agents. Read `docs/PRODUCT.md` first. Version 5 applies the reduced MVP scope (CCR-5) and the implementation simplifications in section 1a.

**Rule for agents:** build only against the interfaces in this file. Do not change a shared interface yourself. Propose changes in `docs/CONTRACT_CHANGES.md`; only the integrator applies them.

---

## 1. Goals of this build

- Submission: one entry in the **Scale** builder track (standalone under published rules; thematic tracks are Genesis-only). The pre-event build is the disclosed arrival baseline; the new work at the event is anchor cash-out to a bank and a passkey smart-wallet claim (section 2). Those event features are planned demos, not Scale eligibility requirements.
- A working MVP for HackMeridian (Lisbon, 25 and 26 Oct 2026): outgoing payouts from a US dollar bank source to a bank account, an e-wallet or a Stellar crypto wallet, over four corridors, with eligibility-based route selection and an explanation of the route.
- Real: payment engine, route selection, per-leg state machine, API, three web screens, claim link, Stellar testnet settlement through the Soroban vault; at the event, anchor cash-out through the SDF test anchor and a passkey smart-wallet claim.
- Simulated and labelled: bank, e-wallet and FX providers, KYC and KYB, quote locks. Real money never moves.
- Every simulated item carries `simulated: true` in data and shows a "Simulated" label in the UI.

## 1a. Reduced MVP and simplifications (CCR-5, 23 Oct 2026)

The product document (section 12) lists what is built and what is shown in the pitch only. These implementation choices keep the demo identical while cutting work:

1. **Synchronous orchestrator.** Simulated providers finish immediately, so the orchestrator runs a payment's legs in order inside one request. There is no background runner, queue or timer. Retry and refund happen inline. Expiry of quotes and claim links is evaluated when they are read or used; the sandbox moves the API clock.
2. **Table-driven route selection.** The route comes from the corridor configuration and the destination type (section 8), then eligibility checks. No cost optimiser. The quote lists the chosen route and the excluded alternatives with reasons.
3. **Settlement adapter by setting.** `FP_SETTLEMENT=mock` (default) or `stellar`. Only flows that must show a real transaction (the claim, DF3, and the event work) use `stellar`; everything else runs on the mock, labelled.
4. **Custodial demo wallet in the baseline.** No wallet connection. The backend holds testnet keys for demo recipients, clearly labelled. The passkey wallet replaces this at the event.
5. **Three web screens** (section 13). No login UI: the API key comes from a setting.
6. **Acceptance is a demo script per flow** (section 15), not a screen per feature.

## 2. Starting point: the existing repo

We build in **github.com/Cseni1/flexipay**, the qualifier project that earned the Meridian invitation. It is a Scaffold Stellar project with a React and Vite app, a `pay_shift` Soroban contract, Vercel deployment and Playwright tests. No secrets were found in the files or git history (checked 22 Oct 2026).

| Keep and reuse | Drop | Park as legacy |
|---|---|---|
| Toolchain set-up (Rust, Stellar CLI, wasm target) | Scaffold example contracts: guess-the-number, nft-enumerable, fungible-allowlist | `contracts/pay-shift` (untouched, not in the new flows) |
| React and Vite app as the base of `apps/web` | Example components and pages (GuessTheNumber, Debug) | Vercel functions `api/pay.js`, `api/health.js` (moved to `legacy/`) |
| Wallet and environment helpers (kept in `packages/web-lib`; wallet connection is not used in the baseline) | Native XLM as settlement asset; the qualifier's shift demo screen and its sample data (not ported, dropped in CF0) | `contracts/pay-shift` and the qualifier Vercel functions (legacy, untouched) |
| Playwright set-up | Hard-coded single payer and worker | |
| Vercel project | | |

Before any change: tag the current state as `qualifier-v1`.

### Submission structure: baseline and event work

Both builder tracks require substantive new work completed during HackMeridian, clearly distinguished from what existed on arrival, and every project must disclose prior work. So the build is split in two:

| Part | When | Content |
|---|---|---|
| **Arrival baseline** (disclosed prior work) | Before 25 Oct, 11:30 | Qualifier `pay_shift` project, the zip prototype, and the pre-event build: domain, routing, orchestrator, API, dashboard, claim page, vault contract on testnet, simulated providers |
| **New work at HackMeridian** | 25 Oct 11:30 to 26 Oct submission | Anchor cash-out to a bank through the SDF test anchor (SEP-10, SEP-38, SEP-24); passkey smart-wallet claim with no seed phrase; fee sponsorship so recipients need no XLM (stretch) |

**Track note (corrected):** published rules make **Scale** a standalone builder track; thematic tracks are **Genesis-only**. Anchor + passkey remain planned event work (section 2), not a Composed-track entry claim.

**Git tags:** `qualifier-v1` (before any change), `arrival` (at 11:30 on 25 Oct, when hacking begins), `submission` (the submitted commit). The diff from `arrival` to `submission` is the event work.

**Still NOT VERIFIED:** the separate event rules on participation and submission integrity (announced at the 09:00 briefing on 26 Oct). Read them on arrival.

## 3. Tech stack (fixed)

| Area | Choice |
|---|---|
| Language | TypeScript everywhere except contracts |
| Runtime | Node 20 or later |
| Repo | Existing repo, **npm workspaces** (as the scaffold uses) |
| API | Express, zod for validation, OpenAPI generated from the zod schemas |
| Database | **Postgres through Prisma** (same engine locally, in tests and on the host) |
| Web | React, Vite, TypeScript; one shared design system |
| Contracts | Rust **1.93** (pinned in `rust-toolchain.toml`), target `wasm32v1-none`, **`soroban-sdk` 26.1.0**, Stellar CLI 28 |
| Chain | Stellar testnet, a test USDC asset issued by our own issuer |
| Tests | Vitest for TypeScript, `cargo test` for contracts, Playwright for UI flows |

### Hosting

| Part | Host | Why |
|---|---|---|
| Web (`apps/web`) | **Vercel** (existing project) | Already wired; automatic Preview URL for every branch |
| API (`apps/api`) | **Long-running Node host**, default Railway (swap to Render or Fly if you already use one; only the API deploy config changes) | Needs Postgres, and Stellar testnet calls can take longer than serverless limits |
| Database | Managed Postgres next to the API | Persistent, same engine as local. Locally and in tests an embedded Postgres from npm is used (`npm run dev --workspace @flexipay/api`) |

**Offline mode (demo fallback):** the whole system runs on one laptop with the embedded Postgres, `FP_SETTLEMENT=mock` and the simulated providers. The public deployment is a separate step (DEV_PLAN) and does not block building.

**Production stays untouched.** Vercel's production branch is set to a separate `production` branch, so merges to `main` only create Previews. One shared Preview API instance deploys from `main`; web Previews point to it through an environment variable. Each branch has **one stable Preview link** (the Vercel branch alias) that always shows its latest build; share that link, never per-deployment URLs.

**One public release for judges.** The rules require a public live URL that judges can explore. On 26 Oct, after the feature freeze, the submitted commit is released once to Production (web) and to a public API URL. Check that Vercel Deployment Protection does not put a login in front of it (NOT VERIFIED for this project). This is the only Production change during the hackathon.

## 4. Repository layout and ownership

Work is split into four **lanes**, each with its own folders so that four agents never edit the same files. DEV_PLAN section 2 says which agent holds which lane. An agent writes only inside its lane's folders. Shared interfaces live in `packages/domain` and change only through the integrator and `docs/CONTRACT_CHANGES.md`.

| Folder | Content | Lane |
|---|---|---|
| `packages/domain` | Types, zod schemas, money helpers, state machine, route selection, corridor config loader, adapter interfaces | A (core) |
| `apps/api` | REST API, auth, orchestrator, sandbox controls, claim endpoints, deploy config | A (core) |
| `packages/adapter-stellar` | Stellar settlement adapter, custodial demo wallet; at the event the anchor adapter | B (chain) |
| `contracts/payout_vault` | Soroban vault contract and `RULES.md` | B (chain), done |
| `scripts/testnet` | Testnet set-up and smoke test | B (chain), done |
| `apps/web` | The three screens (section 13) and the design system | C (web) |
| `packages/web-lib` | Environment helpers (kept from the qualifier) | C (web) |
| `tests/e2e-ui` | Playwright smoke and UI flows | C (web) |
| `packages/adapters-sim` | Simulated providers and the mock settlement adapter | D (simulation and acceptance), done |
| `config/` | `corridors.json`, `providers.json`, `fees.json` | D, done (schema owned by lane A) |
| `scripts/demo`, `scripts/seed`, `tests/e2e` | Demo scripts per flow, seed and reset, sample data (`scripts/seed/demo-data/` is the only place for labelled story data) | D |
| `docs/` | `PRODUCT.md`, `ARCHITECTURE.md`, `DEV_PLAN.md`, `CONTRACT_CHANGES.md` | Integrator |
| `contracts/pay-shift`, `contracts/tip_pool` (not ported) | Legacy and deferred | nobody |
| `legacy/` | Qualifier Vercel functions and `scripts/demo-api.mjs` | nobody |

## 5. Layers

| Layer | Responsibility |
|---|---|
| Web (send payment, payment detail, claim page) | Calls the API only. No business logic. |
| API | Auth, validation, HTTP, idempotency, event log |
| Orchestrator | Creates payments from quotes, runs legs in order inside the request, retries once, refunds, writes events and audit rows |
| Route selection | Builds the route from the corridor and destination type, checks eligibility, returns the route, the excluded alternatives and reasons |
| Adapters | Provider adapters (simulated bank, e-wallet, FX; the anchor at the event) and settlement adapters (Stellar, mock) |
| Contracts | Non-custodial vault on Stellar |

The web screens are clients of the same API that external developers use.

## 6. Domain model

Money is always an integer in minor units, sent as a string in JSON, with an explicit currency or asset code. No floats.

### 6.1 Organization
| Field | Type | Notes |
|---|---|---|
| id | string | |
| name | string | |
| kind | `business` or `individual` | |
| verification | `not_started`, `simulated_verified` | KYC or KYB, simulated |
| apiKeys | list | Stored hashed |

### 6.2 Recipient
| Field | Type | Notes |
|---|---|---|
| id | string | |
| organizationId | string | |
| name | string | |
| kind | `individual` or `company` | Drives eligibility |
| country | ISO country code | |
| endpoints | list of Endpoint ids | Optional; a claim link can add one later |

### 6.3 Endpoint
| Field | Type | Notes |
|---|---|---|
| id | string | |
| type | `bank_account`, `ewallet`, `crypto_wallet`, `crypto_custodial` | Never use "wallet" alone |
| country | ISO country code | Empty for crypto endpoints |
| currency | ISO currency or asset code | For example USD, PHP, USDC |
| network | `stellar` or empty | Only for crypto endpoints |
| details | object, masked when returned | Account number, wallet id or address |
| simulated | boolean | |

### 6.4 Quote
| Field | Type | Notes |
|---|---|---|
| id | string | |
| source | endpoint type, currency, country | |
| destination | endpoint type, currency, country, recipient kind | |
| amount | fixed side (`send` or `receive`) and value | |
| route | ordered list of planned legs | |
| fees | breakdown by leg plus FlexiPay fee | |
| fxRate | decimal string or empty | |
| expectedReceive | amount | |
| priceRiskBearer | `sender`, `recipient` or `partner` | |
| validUntil | timestamp | Default 120 seconds in the demo |
| alternatives | list of other eligible routes with total cost and time | |
| reasons | list of short strings | Why this route, why others were excluded |
| simulated | boolean | |

### 6.5 Payment
| Field | Type | Notes |
|---|---|---|
| id | string | |
| organizationId | string | |
| quoteId | string | Must be valid at creation |
| recipientId | string | |
| externalId | string or empty | Client's own id; duplicates rejected by the API (409). Not the on-chain id. |
| delivery | `direct` (endpoint known) or `claim_link` | |
| profile | `small`, `batch`, `invoice`, `tips`, `domestic`, `one_off` | |
| reference | string | Invoice number, payroll period |
| status | see section 7 | Derived from legs |
| legs | list of Leg | |
| batchId | string or empty | |
| createdAt, updatedAt | timestamps | |

### 6.6 Leg
| Field | Type | Notes |
|---|---|---|
| id | string | |
| paymentId | string | |
| kind | `collect`, `convert`, `settle`, `payout` | |
| rail | string id from `providers.json` | For example `sim_bank_us_ach`, `stellar_usdc`, `sim_ewallet_ph` |
| providerId | string | |
| amountIn, amountOut | amounts with currency | |
| status | see section 7 | |
| externalRef | string | Provider reference or Stellar transaction hash |
| error | code and message | |
| reversalOf | leg id or empty | For reversal legs |
| simulated | boolean | |

### 6.7 Batch, ClaimLink, Webhook
- **Batch:** id, organizationId, payment ids, totals, status (derived).
- **ClaimLink:** paymentId, token hash (raw token only in the link), expiresAt, status (`open`, `accepted`, `expired`).
- **WebhookSubscription:** url, secret, event types. **WebhookDelivery:** event id, attempts, last status.

### 6.8 Corridor (configuration, not code)
| Field | Notes |
|---|---|
| from | country and currency |
| to | country and currency |
| allowedDestinationTypes | endpoint types allowed |
| recipientKinds | `individual`, `company` |
| cryptoLegAllowed | per recipient kind |
| limits | min and max per payment, per recipient kind |
| legsAvailable | provider ids per leg kind |
| domesticRail | provider id when from and to are the same country |
| regulationNote | short text shown in the (i) popover |
| simulated | boolean |

Baseline corridors: US to US, US to Philippines, US to Brazil, US to South Africa (bank only; crypto leg not allowed for companies or individuals until rules are final). EU, UK and Mexico are configuration to add after the event.

## 7. Payment state machine

### Payment statuses
`quoted` → `awaiting_funding` → `funded` → `processing` → `paid`

Side paths: `cancelled` (before processing), `failed`, `refunding` → `refunded`, `expired` (claim link not accepted in time).

### Leg statuses
`pending` → `processing` → `succeeded`, or `failed` → `reversing` → `reversed`

### Rules
- A payment is `paid` only when its last leg succeeds. Legs run strictly in order; a leg starts only when the previous one succeeded. The pure helpers are in `packages/domain/src/state-machine.ts`.
- **Failure before settlement:** reverse the collect leg, payment becomes `refunded`.
- **Failure after settlement, payout failed (MVP):** retry once on the same provider; if it fails again, refund through the settlement adapter and reverse the earlier legs; payment becomes `refunded`. Re-routing to another provider is not built (no second provider exists); the state-machine helper already supports it for later.
- **Refund through the settlement adapter** means: cancel a pending, unexpired payout, or refund an expired one. The adapter chooses (`SettlementAdapter.refund`).
- **Claim links, crypto destination:** the route is `collect → convert → settle`. Funding runs `collect` and `convert` and locks the funds in the vault (the **lock**). The settle leg stays `processing` and the payment stays `processing` until the recipient accepts; accepting releases the funds (the **release**), the settle leg succeeds and the payment becomes `paid`. The visible Stellar transaction is the release; the lock reference is also recorded.
- **Claim links, bank or e-wallet destination:** the payout leg stays `pending` until the recipient accepts and picks the endpoint.
- **Expiry:** evaluated on read and on use against the API clock. An expired claim link refunds the lock and the payment becomes `expired`. An expired quote cannot create a payment; the client re-quotes (422). The sandbox moves the API clock; it does not move ledger time, so a refund test uses a short lock expiry or `cancel`.
- **Duplicates:** a second payment with the same client `externalId` for the same organization is rejected by the API (409). On-chain, every lock uses a per-attempt id, `sha256("<payment id>:<attempt>")` with attempts counted from 1; the vault never accepts the same id twice, even after a refund. A retry after a refund locks again with attempt + 1.
- Every transition writes an event (section 9) and an audit row.

## 8. Route selection (MVP)

Input: a quote request. Output: the chosen route, the excluded alternatives, reasons.

1. **Pick the route template** from the corridor and the destination endpoint type:
   - same country (US to US): `collect → payout` on the domestic rail, no crypto route;
   - bank or e-wallet destination, cross-border: `collect → convert → settle → convert → payout`;
   - crypto wallet destination: `collect → convert → settle` (the vault releases to the recipient; no payout leg);
   - a corridor with no settle rail (South Africa): `collect → convert → payout`, bank only.
2. **Filter by hard constraints:** corridor exists; destination type allowed; recipient kind allowed; crypto leg allowed for this recipient kind; send amount within the send-side limits; every provider on the route is healthy (the sandbox can mark one down); the quote has a validity window.
3. **Choose:** the first eligible provider per leg in the order of `legsAvailable`. There is one policy, `cheapest`, and only one eligible route per destination in the baseline, so no optimiser is needed. Any other policy value is a 422.
4. **Price and explain:** each leg is priced by its provider adapter (`quote`), the vault leg uses the vault's fixed fee read from the contract (`config()`), and the whole chain is converted with `convertMoney` (CCR-4). The quote returns the route, the fee breakdown, the expected receive amount, and `reasons`, which includes why other routes were excluded (for example "Crypto leg not allowed for companies in this corridor"). Where a second route is eligible (for example crypto wallet versus bank in the same corridor for another destination type) it is listed under `alternatives` with total cost.

The route selector is a pure function over configuration and inputs, fully unit tested. The anchor route is added as one more eligible payout provider at the event.

## 9. Events and webhooks

Event types: `payment.created`, `payment.funded`, `payment.processing`, `leg.succeeded`, `leg.failed`, `payment.onchain`, `payment.paid`, `payment.failed`, `payment.refunded`, `payment.expired`, `claim.opened`, `claim.accepted`, `batch.completed`.

- Every event has id, type, created time, payment id and a snapshot of the payment.
- **Webhook delivery is not built in the hackathon MVP** (HMAC signing, retries and delivery logs are post-event). The events are stored and read through `GET /v1/events`.
- The same events feed the payment detail timeline.
- The vault contract also emits on-chain events (payout created, claimed, refunded), so Stellar explorers show them.

## 10. API (version 1)

Authentication: `Authorization: Bearer <api key>`. Every POST accepts an `Idempotency-Key` header. The route table in `apps/api/src/routes` drives both Express and the OpenAPI document (`apps/api/openapi.json`), so they cannot drift.

**MVP routes** (built, or to be built today):

| Method and path | Purpose | Status |
|---|---|---|
| GET `/healthz` | Liveness | built |
| GET `/v1/corridors` | Corridors, allowed endpoint types, limits, notes | built |
| POST, GET `/v1/recipients` | Manage recipients | built |
| POST, GET `/v1/endpoints` | Manage endpoints | to build |
| POST `/v1/quotes` | Quote with route, fees, FX, validity, alternatives, reasons | to build |
| POST `/v1/payments` | Create a payment from a valid quote (direct or claim link) | to build |
| GET `/v1/payments`, GET `/v1/payments/{id}` | List; payment with legs and events | to build |
| POST `/v1/payments/{id}/fund` | Mark funded (simulated collection); runs the legs | to build |
| POST `/v1/payments/{id}/cancel` | Cancel before processing | to build |
| POST `/v1/batches`, GET `/v1/batches/{id}` | JSON rows only | to build |
| GET `/v1/events` | Event log | to build |
| GET `/v1/claims/{token}` | Public: what is waiting for the recipient | to build |
| POST `/v1/claims/{token}/accept` | Public: recipient chooses an endpoint and accepts | to build |
| POST `/v1/sandbox/fail-next` | Make the next `count` calls to a provider fail (also forced failure on or off) | to build |
| POST `/v1/sandbox/provider-health` | Mark a provider down or up | to build |
| POST `/v1/sandbox/advance-time` | Move the API clock (quote and claim expiry) | to build |
| POST `/v1/sandbox/reset` | Reset and reseed the demo | to build |

**Deferred (not in the hackathon MVP):** `POST /v1/payments/{id}/refund` (refunds are automatic), CSV batches, `/v1/webhooks`, `/v1/tips/...`.

Errors: JSON with `code` and `message`, HTTP 400, 401, 404, 409 (idempotency, duplicate or state conflict), 422 (not eligible, with reasons).

## 11. Adapter interfaces

### 11.1 Provider adapter (bank, e-wallet, FX, anchor)
| Operation | Purpose |
|---|---|
| capabilities | Countries, currencies, endpoint types, leg kinds, limits, simulated flag |
| quote(leg) | Fee, FX rate and estimated time for one leg |
| execute(leg) | Start the leg; returns an external reference |
| status(leg) | Current status of the leg |
| reverse(leg) | Reverse a succeeded leg where the rail allows it |
| health | Up or down (sandbox controllable) |

Simulated providers in the baseline (all labelled, six): bank US (ACH), bank Philippines (InstaPay), e-wallet Philippines, bank Brazil (Pix), bank South Africa (EFT), FX. Fees, spreads and times come from `providers.json` and are placeholders, never presented as real prices.

### 11.2 Settlement adapter
| Operation | Purpose |
|---|---|
| network | `stellar` or `mock` |
| fundVault(payer, amount) | Move test USDC into the payer's vault balance |
| lock(payment, attempt) | Create a vault payout (with the per-attempt external id and, for claim links, a claim hash) |
| release(payment, destination) | Claim to the destination address |
| refund(payment) | Return locked funds to the payer balance |
| status(payment) | On-chain state and transaction hash |

Implementations: `StellarSettlementAdapter` (Soroban `payout_vault` on testnet, `packages/adapter-stellar`) and `MockSettlementAdapter` (in memory, same rules, `packages/adapters-sim`, used for tests, offline work and the event fallback). The API chooses one with `FP_SETTLEMENT=mock|stellar`. `refund(payoutId)` cancels a pending, unexpired payout and refunds an expired one. The interface is in `packages/domain/src/adapters.ts`.

### 11.3 Wallet provider
- **Baseline:** demo recipients use custodial testnet keypairs held by the backend, clearly marked. There is no wallet connection in the baseline.
- **Event work:** passkey smart wallet for recipients. The recipient creates a wallet with a fingerprint or face on the claim page, with no seed phrase. The wallet is a contract account, so the vault's `claim` (which requires the receiving address to authorise) works without a contract change, because Soroban contract accounts authorise through their own logic. Tooling is chosen at the event with mentors (candidates: an existing passkey smart-wallet kit or OpenZeppelin smart accounts; NOT VERIFIED which is current and works on testnet).
- **Event stretch:** fee sponsorship (a fee-bump or a relayer) so the recipient needs no XLM. NOT VERIFIED which relayer is available on testnet.
- Interface: create wallet, get address, sign authorisation for a claim or anchor withdrawal, show balance.

### 11.4 Anchor adapter (core event work)
Implements the provider adapter for the **payout leg to a bank** through the SDF test anchor (Option A):
- **SEP-10:** authenticate the recipient's wallet with the anchor.
- **Indicative price:** on the claim page, an indicative SEP-38 `GET /price` (requested with context sep6), clearly labelled indicative.
- **SEP-24:** interactive withdrawal. The anchor's hosted screen shows and applies the binding rate and fees.
- **SEP-31:** only if time allows.

Why this shape: the SEP-24 specification allows a firm SEP-38 quote through `quote_id`, but the SDF test anchor rejects `sep24` as a quote context (it accepts only sep6 and sep31), so a binding quote followed by the hosted screen is not possible on the test anchor.

Test anchor limits (reported by the team on 22 Oct 2026, re-check on Sunday morning): pays out only to USD or CAD bank accounts by wire; SEP-24 withdrawals are limited to 1 to 10 USDC; serves its own test USDC (issuer GBBD47...). The demo says "reference anchor on testnet; local anchors in production".

The routing engine treats the anchor as one more eligible payout provider; the route explanation names it. If the test anchor is down at the event, the route falls back to simulated providers and the demo says so.

## 12. Contracts

Ported from the zip into this repo and moved to `soroban-sdk` 26.1.0.

- `payout_vault`: deposit, withdraw, create payout with claim hash, claim with secret to an address, cancel, refund after expiry, views. No admin key. Fee fixed at deployment. **Added:** a 32-byte external id per lock attempt that the vault never reuses, even after a refund, and on-chain events for created, claimed and refunded. Setup runs in a constructor at deployment so nobody can initialise the contract between deploy and init. `contracts/payout_vault/RULES.md` is the exact spec, including error codes (the duplicate error is #12). Status: ported to `soroban-sdk` 26.1.0 and deployed on testnet; its id is published in `scripts/testnet/testnet-ids.env` and must never be hard-coded.
- `tip_pool`: venues, team weights, monthly plan charged from prepaid balance, tips with no fee, split by weight, staff withdrawal even after the plan lapses. **Not ported in the hackathon MVP** (tips are shown in the pitch only).
- `pay-shift`: legacy, untouched.
- First task on the contracts: port, compile, make all tests pass (22 existing plus tests for the external-id check and events), deploy to testnet.

## 13. Web screens (MVP)

Three screens, built on the existing React and Vite app (`apps/web`). No login UI: the API key comes from a setting. Status is read by polling.

| Screen | Content |
|---|---|
| Send a payment | Source, destination endpoint type, country, amount, recipient kind; the quote panel with route, fees, FX, expected receive amount, validity countdown, reasons and excluded alternatives; choose direct or claim link; confirm and fund |
| Payment detail | Status, per-leg timeline with attempts and errors, the Stellar transaction reference when present, the event log, the simulated labels |
| Claim page (public, phone width) | Amount and fee, choose how to receive (bank, e-wallet or crypto wallet; a demo address in the baseline), accept, status. Built as a list of options so the anchor cash-out and passkey wallet can be added at the event |

The sidebar names **Payments**, **Batches**, **Recipients**, **Tips** and **Developers** are reserved for later; only Payments exists now.

UI rules (one design system for every screen):
- Shared components only; no page-specific styling. Visual base is a teal accent with Inter. FlexiPay's own colours only.
- Status colours follow meaning: Paid and Completed green; Failed and Expired red; Processing and Awaiting funding amber; Refunded and Cancelled grey.
- Lists show 5 rows, expand in place to about 10, then scroll inside the panel.
- Explanations go in an (i) popover; labels stay short.
- Every simulated element shows a "Simulated" label.

## 14. Security and data rules

- Testnet only. No real keys, no real money.
- API keys and claim tokens are stored hashed.
- Secrets live in Vercel and API host environment settings or local env files, never in the repo. Keep the repo's existing pre-commit hook and add a secret scan to CI.
- Account and wallet details are masked in responses and logs.
- Idempotency on every POST.

### Separation and identity rules

- **Separation.** FlexiPay is a standalone project. Nothing from any other product, including FlexiWork, may appear in real code: no logic, config, imports, accounts, keys, domains, environment names, brand colours or code. Real-code folders: `apps/`, `packages/`, `contracts/`, `config/`, `scripts/`. References and demo story names are allowed only in one clearly labelled seed/demo-data folder, in `docs/`, in `legacy/` and in pitch material.
- **Enforcement.** The pre-commit hook and CI fail on a case-insensitive match of the forbidden terms in the real-code folders. The list of forbidden terms lives in one file that the scan excludes.
- **Git identity.** The machine-wide git identity is never changed, because the same laptops are used for other projects. Instead, every repo under the FlexiPay project folder gets its own identity through a conditional include in the global git config pointing at a FlexiPay-only config file: `user.name` "FlexiPay Dev" and `user.email` the builder's own GitHub no-reply address. The commit hook refuses to commit if `user.email` contains the name of another product. History is never rewritten: the 7 qualifier commits keep their original author label.
- **Environment variables.** All use the `FP_` prefix and are listed, names only, in the root `.env.example`. Public testnet ids live in `scripts/testnet/testnet-ids.env`. Secrets live only in the git-ignored `.env.secrets` locally and in the host's secret store online. The names are confirmed through CCR-1 in `docs/CONTRACT_CHANGES.md`.
- **Documents.** Old versions of documents stay outside the repo.

## 15. Demo flows (these are the acceptance tests)

Each flow has a **demo script** under `scripts/demo` that runs the same API calls as the UI, prints the route, the legs and the result, and exits non-zero on failure. A flow counts as done only when its script passes on the integrated build (run with `FP_SETTLEMENT=mock`, and for DF3 also with `stellar`). The written spec is `tests/e2e/SCENARIOS.md`.

| Id | Flow | In the MVP |
|---|---|---|
| DF1 | A data-annotation platform pays three workers in one JSON batch: Philippines e-wallet, Brazil bank account, US domestic bank (router picks the domestic rail and explains why) | API and script only |
| DF2 | A one-off payment from quote to paid | web screens and script |
| DF3 | A claim link opened on a phone, recipient chooses a crypto wallet endpoint, payment settles on Stellar testnet with a visible transaction hash | web screens, script, real testnet |
| DF4 | A payout fails, the engine retries once, then refunds; the timeline shows it | script (sandbox controls), timeline in the UI |
| DF5 | A South Africa payment to a company: crypto route excluded with the reason shown, bank route chosen | web screens and script |
| DF6 | Tips | deferred |
| DF7 | **Event work:** the recipient cashes out to a bank through the anchor (SEP-10, indicative SEP-38 price, SEP-24 interactive withdrawal, 1 to 10 USDC) on testnet | event |
| DF8 | **Event work:** the recipient claims with a passkey smart wallet, with no seed phrase | event |

DF1 to DF5 belong to the arrival baseline; DF7 and DF8 are the new work at HackMeridian.

### Submission deliverables (required by the rules)
| Deliverable | Content |
|---|---|
| Public GitHub repo | This repo |
| `README.md` (rewritten for judges) | Summary, problem, setup, installation, environment variables, demo instructions, links to the public URL and video |
| `docs/STELLAR.md` (architecture overview for judges) | How Stellar is used: assets, contract IDs, anchor, wallets, integrations, APIs, transaction hashes as on-chain evidence |
| `docs/PRIOR_WORK.md` | What existed on arrival (qualifier, zip prototype, pre-event build) and what was built at the event, with the `arrival` to `submission` diff |
| Pitch deck | Problem, solution, target users, value proposition, team, future vision, business model, market opportunity, go-to-market |
| Demo video | Core flows, including DF7 and DF8 |
| Public live URL | The single public release (section 3) |

## 16. Decisions and open items

| Decision | State |
|---|---|
| Reduced MVP scope and simplifications | Decided 23 Oct 2026 (CCR-5) |
| Latin American demo country | Brazil only in the baseline; Mexico later |
| FlexiPay fee | Vault routes: fixed 1 percent set at deployment and read from the vault. `fees.json` (placeholders) sets fees only for legs outside the vault |
| Quote validity | 120 seconds; sender bears price movement and re-quotes on expiry |
| Operating model | Orchestrator only; legal advice later |
| Entry | One Scale builder-track entry (standalone; thematic tracks Genesis-only) |
| Tips module | Deferred; shown as a use case in the pitch |
| API host and Postgres | Railway by default; **not yet created** (account step) |
| Vercel production branch and Preview | **not yet set** (account step) |
| Hackathon rules on pre-existing code, and on participation and submission integrity | NOT VERIFIED; read on arrival and at the 09:00 briefing on 26 Oct |

## 17. Revision notes (v2)

Built on the existing qualifier repo instead of a new one; npm workspaces instead of pnpm; `soroban-sdk` 26.1.0 with Rust 1.93 and Stellar CLI 28; Postgres instead of SQLite; web on Vercel with Production on a separate branch, API on a long-running host; vault gains an external-id check and on-chain events; folder moves (`app` to `apps/web`, `app-lib` to `packages/web-lib`, `e2e` to `tests/e2e-ui`); scaffold examples removed, `pay-shift` kept as legacy.

## 18. Revision notes (v3)

Aligned with the then-understood HackMeridian structure: pre-event arrival baseline; event work is anchor cash-out (SEP-10, SEP-38, SEP-24) plus a passkey smart-wallet claim, with fee sponsorship as a stretch; git tags `qualifier-v1`, `arrival` and `submission`; Preview link and public release; DF7 and DF8; tips as stretch. **Later correction:** Scale is standalone; thematic tracks are Genesis-only — see section 1 and `docs/PRIOR_WORK.md`.

## 19. Revision notes (v4)

Frozen for the build. Added: separation and identity rules (no other product in real code, per-folder git identity, `FP_` environment variables, old document versions outside the repo); vault status (ported, constructor at deployment, deployed on testnet, ids in `scripts/testnet/testnet-ids.env`, never hard-coded); vault fee read from the vault; the product document no longer names any other product.

## 20. Revision notes (v5)

Reduced MVP (CCR-5): outgoing payouts over four corridors; synchronous orchestrator; table-driven route selection; settlement adapter chosen by `FP_SETTLEMENT`; custodial demo wallet in the baseline; three web screens; demo scripts as acceptance; webhooks, CSV batches, Tips, Recipients and Developers screens and automatic provider switching deferred. Lanes replace named owners. The state-machine rules now decide the claim wait for the crypto route, refund semantics (cancel before expiry, refund after) and lazy expiry. Routes marked built or to build.
