# Contract change requests

Proposed changes to shared interfaces. Only the integrator applies them.

## CCR-1: `FP_` environment variable names for Stellar settlement

- **From:** Csenge, Claude (SC1), 22 Oct 2026
- **What:** the names of the environment variables the API and the Stellar settlement adapter read. They are listed in the root `.env.example`. Public values are generated into `scripts/testnet/testnet-ids.env` by `scripts/testnet/setup.sh`. Secrets go to the git-ignored `scripts/testnet/.env.secrets` and, on hosting, only to the host's secret store.
- **Why:** the API (CC2, CC3) and the settlement adapter (SC2) must agree on the names before SC2 starts.
- **Who is affected:** `apps/api` (Csaba, Claude), `packages/adapter-stellar` (Csenge, Claude).
- **Needs:** the API owner confirms or renames these before SC2 starts.
- **Status:** accepted by the integrator (22 Oct 2026). The `FP_` names in `.env.example` are final for SC2 and the API.

## CCR-2: separation guards (demo-data folder, hooks, CI)

> Superseded 1 Nov 2026: the separation script, hook step and CI job were removed at Csenge's request. Kept for history.

- **From:** Csenge, Claude, 22 Oct 2026
- **What:**
  1. **Demo-data location:** `scripts/seed/demo-data/` is the one folder for labelled sample data. Agents write only neutral names ("Demo Platform", "Worker A", "Worker B"). Only a human may add other product or story names there, for the pitch. `scripts/check-separation.sh` excludes any folder named `demo-data/`.
  2. **Hooks on every machine:** add `"prepare": "git config core.hooksPath .husky"` to the root `package.json`, so `npm install` activates `.husky/pre-commit` (the separation check and the commit identity guard). Until then, each machine sets `core.hooksPath = .husky` in its FlexiPay-only git config.
  3. **CI:** keep the `guards` job (`.github/workflows/guards.yml`, which runs `bash scripts/check-separation.sh`), or run the same command in CC0's CI workflow.
- **Why:** keep the other product's name, identity and code out of FlexiPay's real code, enforced locally and in CI.
- **Who is affected:** root `package.json` and CI (Csaba, Claude, CC0); every agent's commits.
- **Status:** accepted (22 Oct 2026). Item 1: `scripts/seed/demo-data/` is the one demo-data folder. Item 2: applied in CC0a (root `prepare` script). Item 3: the `guards` job stays.

## CCR-3: SF0 architect decisions (approved 22 Oct 2026)

- **From:** Csenge, Claude, for the SF0-prep drafts in `config/drafts/` (PR #1)
- **Status:** approved decisions, not open questions. The integrator applies them to the CC0 schemas and loader and to CC1 routing **before CC1 starts**.
- **Decisions:**
  1. **Domestic US route:** collect and payout on `sim_bank_us_ach`, no convert and no settle leg, `domesticRail` `sim_bank_us_ach`, no crypto route.
  2. **South Africa:** bank only; `cryptoLegAllowed` false for both recipient kinds; legs `collect: sim_bank_us_ach`, `convert: sim_fx`, `settle: none`, `payout: sim_bank_za_eft`. Demo policy, not legal advice.
  3. **Limits are send-side, in USD minor units,** on all four corridors (individual 100 to 500000, company 100 to 5000000, all placeholders). Provider limits stay in the provider's own payout currency and are never converted.
  4. **Philippines and Brazil:** `cryptoLegAllowed` true for both recipient kinds. Destinations: PH `bank_account`, `ewallet`, `crypto_wallet`; BR `bank_account`, `crypto_wallet`. No baseline corridor allows `crypto_custodial`.
  5. **A crypto-wallet destination's route ends at settle:** the vault releases to the recipient's address and no payout leg is built. Payout legs exist only for `bank_account` and `ewallet`.
  6. **FX has no limit of its own** (`sim_fx` min and max are absent, not zero); the corridor's send-side limit applies.
  7. **The vault fee comes from the contract** (`config()`, fixed at deployment, 1 percent). It is never a `fees.json` value; `fees.json` and `providers.json` carry fees only for legs outside the vault, recorded once, with no extra FlexiPay margin.
- **Interface question for CC0 and CC1 (needs the integrator's answer):** `legsAvailable` has no per-destination-type filter, so the corridor schema cannot say "payout only for bank and e-wallet destinations". Decide whether decision 5 lives in the routing engine (CC1) or as a corridor field (CC0), so the loader or the router can reject a payout leg for a crypto destination.
- **Answers to the open questions in `fees.md`, from `contracts/payout_vault/RULES.md`:**
  - Fee side: chosen per payout by `FeeMode` (`PayerPays` locks amount + fee; `RecipientPays` pays amount − fee).
  - Rounding: `fee = amount * fee_bps / 10_000`, rounded down (integer division).
- **Integrator answer to the interface question (22 Oct 2026):** decision 5 lives in the **routing engine (CC1)**, not in a corridor field. CC1 builds no payout leg for a `crypto_wallet` or `crypto_custodial` destination, and the route ends at settle. The corridor schema keeps one `legsAvailable` list per leg kind. The CC0a loader checks the corridor side: fiat destination types need a payout provider; crypto destinations need a settle rail and a recipient kind with crypto allowed.

## CC0a: config contracts and adapter interfaces (integrator, 22 Oct 2026)

- **Package:** `packages/domain` (`@flexipay/domain`).
- **Config schemas:** `packages/domain/src/config/schemas.ts`, for `config/corridors.json` (`{ "corridors": [...] }`), `config/providers.json` (`{ "providers": [...], "settlementRails": [...] }`) and `config/fees.json`.
- **Loader:** `packages/domain/src/config/load.ts` (`loadConfig`, `validateConfig`), with the cross-file rules: references, leg kinds, domestic rail, the crypto and South Africa rule, payout coverage, send-side limits.
- **Validation command:** `npm run validate:config` from the repo root (Node 24, no build step).
- **Representation:**
  - Money is `{ "amount": "<integer minor units>", "currency": "USD" }`.
  - Every corridor and provider has `simulated` and `placeholder` booleans. `placeholder: true` marks all its numbers as placeholders.
  - `limits: null` on a provider means no limit of its own.
  - The settlement rail (`stellar_usdc`) is in `settlementRails`, with no issuer, vault id or fee.
  - `fees.json` holds `quoteValiditySeconds`, `priceRiskBearer` and `tipsFeeBps`, plus `placeholder`. It has no vault fee field.
- **Adapter interfaces:** `packages/domain/src/adapters.ts` (`ProviderAdapter` for SF1, `SettlementAdapter` and `SettlementError` codes for SF2 and SC2).


## CCR-4: simulated provider behaviour (integrator decisions, 22 Oct 2026)

Answers for SF1 (`packages/adapters-sim`) and the sandbox API (CC3). Status: **approved**. The interfaces are in `packages/domain/src/adapters.ts`, the conversion helper is `convertMoney` in `packages/domain/src/money.ts`, and the rates are in `config/providers.json`.

1. **Sandbox failure and health controls** (`SandboxControls`).
   - `failNext(providerId, count = 1)`: the next `count` `execute()` calls on that provider run and then fail.
   - `setForcedFailure(providerId, on)`: while on, every `execute()` on that provider fails (DF4: no alternative, so refund).
   - `setHealth(providerId, "up" | "down")`: routing filters a down provider out at quote time; a leg that runs on a provider marked down afterwards fails with `provider_down`.
   - `reset()` clears all overrides.
   - A failing leg is not an exception. `execute()` returns its reference; `status(ref)` then reports `failed` with `error.code` `sandbox_forced_failure` or `provider_down`. `execute()` and `reverse()` throw `ProviderError` only for invalid or disallowed requests (codes in `PROVIDER_ERROR_CODES`).
2. **FX rates** are configuration: `fxRates` in `config/providers.json`, one entry per direction, never derived by inverting another. Rate = major units of `to` per one major unit of `from`, a decimal string with up to 7 decimals, all placeholders. Approved: USD>USDC 1, USDC>USD 1, USDC>PHP 56, USDC>BRL 5.5, USDC>ZAR 18, USD>ZAR 18. Minor-unit decimals are fixed in `CURRENCY_DECIMALS` (USD, PHP, BRL, ZAR = 2; USDC = 7). `convertMoney` is the only conversion: integer maths, rounded down. The loader rejects a corridor that lacks a rate it needs (from>USDC and USDC>to on a stablecoin route; from>to otherwise).
3. **Fee composition and side.** For any leg: `fee = fixed + amountIn * bps / 10_000` (rounded down), in the leg's input currency. A zero fixed fee is valid in any currency; a nonzero fixed fee must be in the input currency or the call fails with `currency_mismatch`. The fee is deducted from the leg's input: `amountOut = amountIn − fee`; a `convert` leg then converts the net, and applies the spread: `out = convert(amountIn − fee) * (10_000 − fxSpreadBps) / 10_000`, rounded down. A fee at or above the input fails with `fee_exceeds_amount`. Min and max limits compare the input amount (`below_min`, `above_max`). A provider with `limits: null` has none. The vault fee is never part of provider fees (RULES.md, CCR-3).
4. **Reversal and replay.**
   - Only succeeded `collect` and `convert` legs are reversible. `payout` and `settle` throw `not_reversible` (a succeeded payout means the payment is paid; settlement returns through the vault refund). A leg that has not succeeded throws `not_succeeded`; an unissued reference throws `unknown_reference`.
   - `reverse()` is idempotent: the same reference always returns the same reversal reference. `status()` of a reversed leg reports its state as `succeeded` with the reversal recorded; the orchestrator owns the `reversing`/`reversed` leg statuses.
   - `execute()` is idempotent per `(legId, attempt)`: the same call returns the same reference and never changes state, including after a failure or a reversal. It never revives a failed or reversed leg. A retry uses `attempt + 1` and gets a new reference (the same rule as vault lock attempts). The reference is derived deterministically from provider id, payment id, leg id and attempt, so a replay after a restart is the same call.
5. **Lockfile.** Branches do not commit `package-lock.json`. The integrator regenerates it at merge and runs a fresh `npm ci` check.
6. **Clarifications from the SF1 review (22 Oct 2026).**
   - The provider reference is `<providerId>:<paymentId>:<legId>:<attempt>`. This is equivalent to "per (legId, attempt)": a leg id belongs to exactly one payment.
   - `failNext(count)` is consumed only by an execution it fails. A provider marked down, or with a forced failure on, fails the call first and does not consume it. A replayed or rejected call never consumes it.
   - A reversed leg keeps `status()` `succeeded`. The reversal is visible only through `reverse()` returning the same reversal reference; the orchestrator owns the `reversing` and `reversed` leg statuses.

## CCR-5: reduced hackathon MVP and implementation simplifications (integrator decision, 23 Oct 2026)

Status: **approved** by the project owner on 23 Oct 2026. The documents `PRODUCT.md` v4, `ARCHITECTURE.md` v5 and `DEV_PLAN.md` v5 in this folder apply it and replace all earlier versions.

1. **Scope.** The MVP is outgoing payouts from a US dollar bank source over four corridors (US, Philippines, Brazil, South Africa) to a bank account, an e-wallet or a Stellar crypto wallet. Deferred to the pitch only: other sources and countries, CSV import, Batches, Recipients and Developers screens, Tips, webhook delivery, cost/speed/balanced optimisation, automatic provider switching, a manual refund route.
2. **Orchestrator** is synchronous: legs run in order inside the request; retry once, then refund; expiry is evaluated on read and on use against the API clock (sandbox `advance-time` moves it). No background runner.
3. **Route selection** is table-driven by corridor and destination type, then eligibility; one policy (`cheapest`); the quote lists the chosen route, exclusion reasons and any eligible alternatives. A crypto-wallet destination's route ends at settle (CCR-3 decision 5 lives here).
4. **Claim wait (answers the CC2 question from the SF3 scenarios).** Crypto destination: funding runs collect and convert and locks the funds; the settle leg and the payment stay `processing` until the recipient accepts, which releases the funds and completes the payment. `payment.onchain` is emitted at the lock and at the release. Bank or e-wallet destination: the payout leg stays `pending` until accept.
5. **Refund** through `SettlementAdapter.refund` means cancel before expiry, refund after expiry. Ledger time is not moved by the sandbox.
6. **Settlement adapter** is chosen by `FP_SETTLEMENT=mock|stellar` (default `mock`). Only DF3 and the event work need `stellar`.
7. **Baseline wallet** for recipients is a labelled custodial testnet wallet; no wallet connection. The passkey wallet replaces it at the event.
8. **API contract first (task A0):** the zod schemas for quote, payment, claim, event and sandbox bodies are added to `packages/domain` before the other lanes build against them.
9. **Lanes** replace named owners (DEV_PLAN section 2). Acceptance is a demo script per flow.

## CCR-6: sandbox `advance-time` request body (accepted, 23 Oct 2026)

- **From:** A0 / sandbox stubs (`packages/domain/src/api/sandbox.ts`, OpenAPI); #43 ask.
- **Status:** **accepted and applied.** Identifier **CCR-6 stays with advance-time** (do not reuse for simulation flags).
- **Accepted shape:**
  - **Request:** `{ seconds: int 1..86400 }` (strict).
  - **Response:** `{ now: IsoTimestamp }` — API clock **after** the advance.
  - Moves **API clock only** (quote/claim expiry). Does **not** move Stellar ledger time (CCR-5).
- **Who implements:** A0 schemas (this commit); CC3b sandbox route mounts the schemas.
- **Note:** An earlier draft briefly labelled per-leg `simulated` as “CCR-6”; that topic is **CCR-10** below. Both requests remain under distinct ids.

## CCR-7: `Quote.fees.total` aggregation (accepted; option A rates applied, 23 Oct 2026)

- **From:** integrator, after CC1 follow-up PR #28 (`d371241`).
- **Status:** **accepted and applied.** Option A placeholder reverse rates are in `config/providers.json`. Option B (zero payout fees) was an alternative only and is **not** approved.
- **Accepted rule (matches #28 / CCR-4):**
  1. `fees.total` is a single `Money` in the **send / source currency**.
  2. Sum every positive non-settle leg fee plus `flexiPayFee`, each converted into send currency with a **configured directional** `fxRates` entry only (`convertMoney`).
  3. Zero fees need no rate. Settle fee is counted once via `flexiPayFee`, not again from the settle row.
  4. If any positive fee lacks `fee.currency > sendCurrency`, the quote **fails** with an explicit reason. Silent omission is forbidden.
- **Applied directional rates (option A)** — unit = major units of **USD** per one major unit of the foreign currency; `placeholder: true`; 7-decimal ROUND_DOWN strings; **no runtime inversion**:

  | from | to | `rate` |
  | --- | --- | --- |
  | PHP | USD | `0.0178571` |
  | BRL | USD | `0.1818181` |
  | ZAR | USD | `0.0555555` |

- **Who is affected:** CC1 pricing, config, DF1/DF2/DF5, web quote panel.
- **Not accepted:** runtime derivation of inverses from forward USDC→PHP / USDC→BRL / USDC→ZAR / USD→ZAR.

## CCR-8: vault `FeeMode` on quote → payment → lock (accepted; no silent default, 23 Oct 2026)

- **From:** integrator, after PR #28. Sources: `contracts/payout_vault/RULES.md`, CCR-3, `config/drafts/fees.md` Q-fee-side (was open), A0 had no field.
- **Status:** **accepted — no MVP product default.** Caller must choose. A0 gains `feeMode` (this commit).
- **Contract:**
  - `CreateQuoteRequest.feeMode` optional in the schema; **required by CC1/CC3 whenever the chosen template includes settle** (422 / quote fail otherwise) — same as #28 `vaultFeeMode`.
  - `Quote.feeMode`: `PayerPays` | `RecipientPays` when settle is on the route; `null` when it is not.
  - `CreatePayment` does not re-specify mode; payment + `SettlementAdapter.lock` **must reuse `quote.feeMode` unchanged**.
- **Money conservation (binding on CC1 pricing and CC2 lock; both modes):**
  Let `A` be the settlement-asset amount available at the settle leg after prior legs (send-fixed path). Let `bps` be vault `feeBps`, `f(P) = floor(P * bps / 10000)`.
  - **RecipientPays:** settle `amountIn = A`, `fee = f(A)`, `amountOut = A − fee` (fail if `fee ≥ A`), lock `locked = A`, `net = A − fee`. Same send envelope never yields lock principal above `A`.
  - **PayerPays:** fee is **not** created from thin air. Choose principal `P = floor(A * 10000 / (10000 + bps))` so `P + f(P) ≤ A`. Settle `amountIn = P`, `amountOut = P`, `fee = f(P)`, lock `locked = P + fee`, `net = P`. `#28` currently prices PayerPays as `amountOut = amountIn` without reducing `P` from `A` — **Csaba Cursor must apply this sizing in CC1** before CC2 locks, or lock will demand more than the funded vault balance.
- **Owner decision (optional product default for demos):** if the pitch wants a default when the client omits `feeMode`, pick **PayerPays** or **RecipientPays** explicitly. Until then demos/API clients pass it. Integrator will not invent one.
- **Who is affected:** A0 (this commit), CC1 (pricing + sizing), CC2/CC3 (persist and lock), SC2 (already takes `feeMode`), DF3 (assert claimed `net`).

## CCR-9: crypto `destination.country` disambiguation (accepted, 23 Oct 2026)

- **From:** integrator, confirming PR #28 against ARCHITECTURE §6.3 (`CountryOrEmpty`) and corridor keys `(from.country, to.country)`.
- **Status:** **accepted.**
- **Rule:**
  - Non-empty `destination.country` → unique corridor `from+to`, or fail.
  - Empty country + crypto destination → corridors from the source that allow the type/kind and have a settle rail. **Exactly one** match → use it; **zero** → fail; **two or more** → fail with an explicit ambiguous-corridor reason (require `destination.country`). **No arbitrary first-match.**
- **MVP implication:** US→crypto with both PH and BR eligible must send `destination.country` (`PH` or `BR`). Empty country remains valid only when a single corridor matches.
- **Who is affected:** CC1 (done in #28), web send form, D1 fixtures (set country on crypto quotes).

## CCR-10: per-leg `simulated` on quote routes (accepted, 23 Oct 2026)

- **From:** integrator / owner decision after the mislabelled “CCR-6” simulation proposal.
- **Status:** **accepted and applied.** Identifier is **CCR-10** (CCR-6 remains advance-time).
- **What:** `PlannedLegSchema.simulated` is `z.boolean()`. Quote-level `QuoteSchema.simulated` stays `z.literal(true)` because MVP fiat/FX legs are simulated.
- **Derivation (binding on CC1):**
  - Provider legs: use the provider adapter quote’s `simulated` flag (config / adapter), not a hard-coded `true`.
  - Settle leg: use **settlement execution mode** from the caller (`settlementSimulated` on quote deps). `FP_SETTLEMENT=mock` → `true`; `FP_SETTLEMENT=stellar` → `false`. **`stellar_usdc` rail id alone does not prove real execution** (mock can still price that rail).
- **UI:** show “Simulated” only when the leg’s `simulated` is true.
- **Who is affected:** A0, CC1 pricing, CC3 (`buildQuote` deps from `FP_SETTLEMENT`), web labels, OpenAPI.
- **Out of scope:** inventing browser auth; changing claim-surface `simulated: true` labels.

## CCR-11: restart-safe claim secret / hash (accepted, 23 Oct 2026)

- **From:** CC2 draft #32 blocker list; integrator closure.
- **Status:** **accepted** (schema + env name). CC2/CC3 implement seal/unseal and stop using process-local `Map` as sole storage.
- **Durable fields on `ClaimLink` (Prisma):**
  - `vaultClaimHashHex` — sha256 of the vault claim secret (hex). Same value passed as `LockRequest.claimHashHex`. **Not** a secret; required once a settle lock exists for `claim_link` delivery.
  - `secretSealed` + `secretSealedNonce` — AES-256-GCM ciphertext of the raw claim secret (bytes). Decrypt only inside the API host for `SettlementAdapter.release`.
- **Key:** env `FP_CLAIM_SEAL_KEY` — 32-byte key as 64 hex chars (name in root `.env.example`, value never committed).
- **Forbidden:** plaintext secret in Event / Audit / API JSON / logs; returning sealed blob or secret on public ClaimView / Payment responses.
- **Recovery:** after restart, load ClaimLink by paymentId → decrypt secret → `release({ payoutId, secretHex, destination })`.
- **Escalation (security product):** MVP demo uses env-held seal key (not HSM/KMS). Production must replace with a host secret manager; until then treat as demo-grade. Owner may reject env-key later without changing column shapes.
- **Who implements:** Csaba Cursor (CC2 persist on lock; CC3 claim accept decrypt). Integrator owns schema/migration this commit.

## CCR-12: distinct durable settlement identifiers (accepted, 23 Oct 2026)

- **From:** CC2 #32; prisma comment wrongly allowed tx hash in `Leg.externalRef`.
- **Status:** **accepted and applied** (A0 + Prisma).
- **Rules:**
  - **Vault `payoutId`** — opaque contract id (decimal string). For **settle** legs, `Leg.externalRef` **MUST** be this payoutId only. It is **not** a transaction hash. Used for `status` / `release` / `refund`.
  - **`Leg.lockTxRef`** — Stellar (or mock) transaction hash from `LockResult.txRef`. Nullable until lock succeeds.
  - **`Leg.releaseTxRef`** — hash from `ReleaseResult.txRef` **or** from a vault **refund/cancel** tx on the refund path (CCR-15 fee-drift / payout failure). Nullable until release **or** refund succeeds. **Do not rename** this field for refunds.
  - Provider legs keep `externalRef` as the provider reference string; `lockTxRef` / `releaseTxRef` stay null.
- **Consumer rule (clarified 23 Oct 2026):** presence of `releaseTxRef` alone is **not** proof of a successful claim release. Interpret with:
  - `Payment.status` (`paid` ⇒ claim/release path; `refunded` / settle `failed` ⇒ refund path),
  - settle `Leg.status` / `errorCode`,
  - and/or `payment.onchain` event `phase` (`release` vs `refund`).
  UI and DF scripts must not label a refund hash as a claim release or treat it as `paid`.
- **Acceptance scripts** may use public Horizon effects on `releaseTxRef` plus `externalRef` as payoutId; never require secrets. For DF3 release proof, require `payment.status === paid` (and settle succeeded) before verifying `releaseTxRef` as a **claim** invoke.
- **Who implements:** CC2 writes the three fields; do not overwrite `externalRef` with a tx hash. UI copy: Freebuff. No schema rename.

## CCR-13: quote → payment → lock frozen amounts (accepted, 23 Oct 2026)

- **From:** #34 remainder gap + CC2 create-from-quote blocker.
- **Status:** **accepted and applied** (A0 + CC1 wiring this commit).
- **Contract:**
  - Every `PlannedLeg` carries frozen `amountIn` and `amountOut` (Money).
  - `FeeBreakdown.settleUnlockedRemainder`: Money in settlement asset, or `null` when no settle / RecipientPays / remainder is zero. **This is accounting**, not a substitute for `reasons` text.
  - `Quote.feeMode` (already on A0) and Prisma `Quote.feeMode` persist the mode used to price settle.
  - On payment create, copy each PlannedLeg’s amounts into `Leg.amountIn*` / `amountOut*`. **Do not re-price.**
  - Lock request: `amount` = settle leg `amountIn` (= principal **P**), `feeMode` = `quote.feeMode`, fee must equal `fees.flexiPayFee` / `f(P)`. Locked on-chain = `P + f(P)` (PayerPays) or `P` (RecipientPays).
  - **PayerPays remainder** `A − P − f(P)` stays in the payer’s **unlocked** vault balance (already deposited). It is **not** locked, **not** a fee, **not** sent to the recipient. No extra ledger row required beyond `settleUnlockedRemainder` on the quote and leaving funds unlocked.
- **Stale quote:** if `validUntil` passed → 422, no payment (existing rule). Config/feeBps drift after quote: lock must still use **quoted** P and feeMode; startup adapter still checks live vault `feeBps` matches env (existing SC2). Do not expand into re-quote-on-fund in this CCR.
- **Adapter evidence note:** testnet release of **1.0000000 USDC** net to Worker A with **0.0100000** treasury fee means principal **P = 1 USDC** and fee **f(P)** under PayerPays; payer vault debit for the lock was **P + f(P) = 1.01 USDC**, not a fixed 1 USDC all-in budget.
- **Who implements:** integrator (schema + CC1 export); CC2 payment create + lock; CC3 routes.

## CCR-14: exactly one payout retry under `processing` (accepted, 23 Oct 2026)

- **From:** CC2 #32 SM workaround ask (option a).
- **Status:** **accepted** — document, do not add `failed → processing`.
- **Rule:** `decideOnFailure` returns `retry` while `attemptsOnProvider < 2` (first try counts as 1). On retry the orchestrator **keeps** leg status `processing`, sets `attempt = attempt + 1`, clears provider/settle ref fields as needed for the new attempt, and must **not** call `assertLegTransition(processing, processing)` as a status change (no-op status). Audit/event payload **must** record `attempt` before and after.
- **Evidence:** attempt 1 failure → attempt 2 execution → on second failure `refund_vault` (no attempt 3). Durable `Leg.attempt` (Prisma + A0) is the source of truth.
- **Forbidden:** undocumented bypass of other `assertLegTransition` paths; treating text-only timelines as proof.
- **Who implements:** CC2 (already close); expose `attempt` on A0 `LegSchema` this commit.

## CCR-15: orphan-lock recovery after fee-drift (accepted, 23 Oct 2026; claim bypass clarified)

- **From:** integrator review of CC2 fee-drift path (`run.ts`); #32 / #46 follow-up; Freebuff public-API evidence on `main` `286d044` (`scripts/demo/evidence/2026-10-23-orphan-lock-286d044.md`).
- **Status:** **accepted.** Persist+no-re-lock (#46) is **PARTIAL only**. End-to-end “never paid on drift” is **OPEN** until step 2–5 land. A UI guard is **not** a fix.
- **Counters (do not conflate):**
  - **`Payment.lockAttempt`** — vault lock-attempt counter. Derives the settle external id (`sha256("<paymentId>:<attempt>")`) and is the attempt argument to `findLock`. CCR-15 recovery keys off this.
  - **`Leg.attempt`** — provider execute/retry counter (CCR-14: at most one payout retry). The settle lock path does **not** advance `Leg.attempt` for a vault lock. Reporting “attempt” for orphan-lock must say **`lockAttempt`**, not CCR-14 provider attempt.
- **Required behavior:**
  1. **Persist first:** immediately after `lock` returns, write settle `externalRef = locked.payoutId` and `lockTxRef = locked.txRef` (and emit `payment.onchain` lock phase). **Then** compare `locked.fee` to quoted `flexiPayFee`.
  2. **On fee mismatch after persist:** keep those refs; mark the settle leg **`failed`** with a **durable** error (and a durable event/reason that names fee drift); do **not** clear refs. Call **`refund_vault`** for that `payoutId` (same adapter path as payout failure). Then surface the drift error to the caller (e.g. fund → 409). Payment must **not** be `paid`.
  3. **Reject claim release** for that payment: `completeClaimSettle` / `POST /v1/claims/{token}/accept` must **not** release or mark `paid` when the settle leg is failed (or otherwise marked drift-failed). Leaving settle `processing` after drift is forbidden — that is the Freebuff bypass (claim accept 200 → `paid` at the mismatched on-chain fee).
  4. **Refund failure:** if `refund_vault` throws, keep refs; leave settle **`failed`** with durable error that records both drift and refund failure; still reject claim release; do **not** re-lock on replay. Operator/recovery may retry refund later; silent Pending+claimable is forbidden.
  5. **Replay** with durable refs: never re-fund / re-lock; never mark `paid` from fund or claim while drift-failed. Crash window: `findLock(vaultPayer, paymentId, lockAttempt)` as before.
- **Acceptance before closing “never paid on drift”:** public-API reproduction (quote @ 100 bps → restart @ 50 bps → fund 409 → claim accept **must not** pay) **and** unit/orchestrator tests covering refund success, refund failure, and replay. Duplicate-lock prevention alone is insufficient.
- **Who implements:** CC2 orchestrator + claim settle gate (Csaba). Integrator reviews; does not duplicate CC2.

## CCR-16: `POST/GET /v1/endpoints` (accepted, 23 Oct 2026)

- **From:** #43 contract asks.
- **Status:** **accepted and applied** as A0 schemas/stubs (`ad9dc2c` / main via #45). **Executable Express routes are not on main until CC3b #43 mounts them** — seed/DF remain blocked on routes, not on missing schemas.
- **Auth:** `api_key`.
- **POST body:** `{ recipientId, type, country, currency, network, details, simulated: true }` with §6.3 country/network rules.
  - crypto (`crypto_wallet` | `crypto_custodial`): `country=""`, `network:"stellar"`, `details.address` (string).
  - `bank_account`: country ISO, `network:null`, `details.accountNumber` (string).
  - `ewallet`: country ISO, `network:null`, `details.phoneNumber` (string).
  - No other detail keys; no `syntheticRef` in the contract (map fixture refs into these keys at the caller).
- **Response:** `EndpointSchema` (`id`, `organizationId`, `recipientId`, type/country/currency/network, `details` masked strings, `simulated`, `createdAt`).
- **GET** `/v1/endpoints?recipientId=` optional → `{ endpoints: Endpoint[] }`.
- **Who implements:** A0 schemas (integrator); CC3b routes (Csaba).

## CCR-17: claim-accept `details` keys (accepted, 23 Oct 2026)

- **From:** #43; unblocks fiat claim accept.
- **Status:** **accepted and applied.**
- **Rule:** `ClaimAcceptEndpointSchema.details` uses the **same type-specific keys** as CCR-16 (`address` | `accountNumber` | `phoneNumber`). Values are opaque strings.
- **Who implements:** A0 (integrator); CC3 claims route removes the temporary fiat/details block once schemas land.

## CCR-18: `POST/GET /v1/batches` (accepted, 23 Oct 2026)

- **From:** #43 contract asks.
- **Status:** **accepted and applied** as A0 schemas/stubs (`ad9dc2c` / main via #45). **Routes still CC3b #43** (same as CCR-16).
- **Auth:** `api_key`.
- **POST body:** `{ feeMode, rows: [{ recipientId, endpointId, amount (Money), externalId, profile: "batch" }] }` (1..50 rows).
- **Implementation rule:** create quote + payment **per row via the existing CC3a payment engine** (no second orchestrator).
- **Response / GET** `/v1/batches/{id}`: `{ id, organizationId, status, paymentIds, totals: { count }, createdAt }` with `status ∈ open|processing|completed|failed`.
- **Who implements:** A0 schemas (integrator); CC3b routes (Csaba).

## CCR-19: browser access to `api_key` routes (accepted, 23 Oct 2026)

- **From:** integrator CF1/CF4 reviews (#29 / #37); no prior accepted BFF existed on main.
- **Status:** **accepted.** Implementation owned exclusively by **Freebuff on #29** (web). Integrator does **not** add a second BFF; Csaba’s agent must **not** edit `apps/web/**`, `packages/web-lib/**`, or `tests/e2e-ui/**` for auth/proxy.
- **Scope:** the Vite `server.proxy` pattern is a **local-development** solution only. It does **not** supply authentication for a **deployed static build**; a hosting BFF (later) is out of scope for this CCR.
- **Split surfaces:**
  1. **Protected payment API** (`auth: api_key`): `/v1/quotes`, `/v1/recipients`, `/v1/payments*`, `/v1/events`, `/v1/endpoints*`, `/v1/batches*`, `/v1/sandbox/*`. Browser must **never** receive `FP_API_KEY` (not in Vite `define` / `envPrefix` / bundle).
  2. **Public claim API** (`auth: none`): `GET/POST /v1/claims/{token}` (+ accept). Separate client; **no** `Authorization` header. Token only in the URL path; never stored in web storage.
- **Minimal accepted pattern (local demo):** same-origin **dev proxy** (Vite `server.proxy` or equivalent small Node forwarder) so the web origin calls relative `/v1/...`:
  - For **protected** paths: proxy injects `Authorization: Bearer <key>` from **server-side** env (`FP_API_KEY` readable only by the Node/Vite process). Forward `Idempotency-Key` and JSON body unchanged.
  - For **claim** paths: proxy forwards **without** injecting Bearer (or browser may call `FP_API_URL` directly for claims only).
  - Prefer proxy over opening CORS on the API for demo; if claims are called cross-origin without proxy, API may later allow those two routes from the web origin **without credentials** — not required while proxy is used.
- **Forbidden:** shipping `FP_API_KEY` / `FP_*_SECRET` into the browser bundle; treating Playwright fixture PASS as DF2/DF3 acceptance; treating CF4 Accept UI gates as CCR-15 backend proof; claiming the Vite proxy authenticates production static hosting.
- **Who implements:** **Freebuff (web)** on #29. **Integrator** accepts this CCR; does not implement the proxy. **Csaba (API)** keeps Bearer auth as today; no CORS change required for the proxy path.
- **Acceptance:** CF1 can create quote/payment/fund through the **local** proxy **without** the key appearing in built assets or browser page-JS request headers. Fixture-only e2e does **not** close DF2/DF3.

## CCR-20: reference-anchor (M1) env names + client surface (**accepted** with renames, 25 Oct 2026)

- **From:** Csenge Cursor (E1), event plan M1.
- **Status:** **accepted** by Claude with name corrections (Cursor applied on #61).
- **What:**
  1. **Public env names** for the SDF reference anchor and an isolated second vault (anchor USDC issuer `GBBD47…`), without replacing baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` in `testnet-ids.env`:
     - `FP_ANCHOR_HOME_DOMAIN`
     - `FP_ANCHOR_USDC_ASSET` (full `CODE:ISSUER`)
     - `FP_ANCHOR_USDC_CONTRACT_ID`
     - `FP_ANCHOR_VAULT_ID` (was proposed `FP_EVENT_PAYOUT_VAULT_ID`)
     - `FP_ANCHOR_VAULT_FEE_BPS` (was proposed `FP_EVENT_VAULT_FEE_BPS`)
     - `FP_ANCHOR_VAULT_TREASURY_ADDRESS` (was proposed `FP_EVENT_TREASURY_ADDRESS`)
     - `FP_ANCHOR_VAULT_PURPOSE` (was proposed `FP_EVENT_VAULT_PURPOSE`)
  2. **Adapter exports** in `@flexipay/adapter-stellar`: `ReferenceAnchorClient` (SEP-10 / SEP-38 indicative `context=sep6` / SEP-24 interactive + poll), asset identity helpers, `sanitiseHostedUrl`. JWT and interactive URL query tokens stay out of logs/evidence; use `urlSanitised` only.
  3. **M1 success rule:** SEP-24 status `completed` plus verified amount, asset identity, destination and memo. Persist **three** distinct refs: SEP-24 **anchor transaction id**, **anchor payment hash** (classic memo / `stellar_transaction_id`), and **vault release hash**. UI wording: “reference anchor on testnet, pays a US-dollar bank account in a sandbox”.
- **Who is affected:** `packages/adapter-stellar` (Csenge); `apps/api` + claim UI (Csaba) for wiring; DF7 (Freebuff) consumes the client.
- **HTTP:** Csaba proposes request shapes in his PR; no additional CCR wait for the three server calls (indicative price, start withdrawal/hosted URL, poll status).
- **Out of scope here:** SEP-45 / passkey (M2); changing baseline vault on-chain config.

## H1 Stellar fee-drift reproduction (**approved**, 25 Oct 2026)

- **From:** Csenge Cursor (M3 / H1).
- **Status:** **approved** by Claude (independent of CCR-20). Configuration drift between vaults (100 → 50 bps), not an on-chain fee mutation of the baseline vault.
- **What:** Same-token vault at `fee_bps=50` (baseline GBBO6N SAC); baseline vault at 100 untouched; isolated DB; public API expects **409 `fee_drift`**, payment **`refunded`**, claim accept **409 `settle_failed`**, one lock + one refund on-chain, idempotent replays without duplicate funding/locks/refunds; prove payer vault balance conserved across lock→refund.
- **Doc:** `scripts/demo/H1-REPRODUCTION.md`.
- **Out of scope:** re-running E1/H2; changing CCR-15 wire shape; other chains.

## CCR-21: public passkey claim API (M2) — **ACK'd** (944cabb / renumbered from draft CCR-20)

- **From:** Csaba Cursor M2 plan (`event/csaba-cursor/m2-passkey`); EVENT_PLAN §4 E2.
- **Status:** **ACK'd** by Csaba (implementation base `944cabb`). Number **CCR-21** because **CCR-20** is the accepted reference-anchor surface on `main`. Deploy/prepare/submit mount on the event branch. Still **not** merged to `main` until the event gate.
- **Who implements:** Csaba Cursor (API + `packages/adapter-stellar`); Freebuff wires `apps/web` / proxy allowlist against mounted paths.
- **Out of scope:** E1 anchor, H1/H2, fee sponsorship, SEP-45 passkey→bank, web UI in this CCR.

### Public routes (`auth: none`)

| Method | Path | Idempotency-Key | Body schema | 200 schema |
|---|---|---|---|---|
| POST | `/v1/claims/{token}/passkey/deploy` | required | `PasskeyDeployRequestSchema` | `PasskeyDeployResponseSchema` |
| POST | `/v1/claims/{token}/passkey/prepare` | not used | `PasskeyPrepareRequestSchema` | `PasskeyPrepareResponseSchema` |
| POST | `/v1/claims/{token}/passkey/submit` | required | `PasskeySubmitRequestSchema` | `PasskeySubmitResponseSchema` |

Existing `GET /v1/claims/{token}` and `POST /v1/claims/{token}/accept` are unchanged (G / custodial DF3 path).

### Wire encoding (no alternates)

- Every `signedTx`, `authEntries[]`, `signedAuthEntries[]` value is **base64 Stellar XDR** (`toXDR("base64")` / `fromXDR(..., "base64")`).
- Kit pin (implementation): `passkey-kit@0.19.1`, wallet WASM `97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e`.
- Deploy fee path: **shared deployer carrier** from the browser + backend **`FP_PAYER_DEMO_*` as RPC envelope source**. No new relayer service.

### HTTP idempotency (deploy + submit)

Reuse `IdempotencyRecord` / `withIdempotency` (`apps/api/src/app.ts`):  
`requestHash = sha256(method + " " + path + " " + JSON.stringify(body))` — **hash only**, never store secret-bearing request bodies.  
Scope: `organizationId` = the claim payment’s `organizationId` (load claim by token first).

**Unique scope / foreign-response rule:** `@@unique([organizationId, key])` alone is not enough. The hash **must** include the full path (with claim token). Same Idempotency-Key on another claim path or different body → `requestHash` mismatch → `409 idempotency_conflict` (never return another claim’s cached body).

**Before returning a cached `responseBody`:** re-load the claim by URL token; verify the token is still valid for that payment (`tokenHash`, not expired into a forbidden state for this call); verify `payment.organizationId` still matches the idempotency row’s `organizationId`. If the claim is gone or unbound → `404` / `409`, do **not** return the cache.

**Forbidden in `responseBody`:** plaintext `authEntries` / `signedAuthEntries` / `signedTx` / claim secret. Deploy/submit success bodies (`contractId`, tx hashes, `ClaimView`, `releaseTxRef`) are fine. Prepare does not use Idempotency-Key (secret-bearing `authEntries`).

Atomic prepare **reserve** and on-chain **pendingTx*** recovery remain separate from HTTP idempotency.

### Deploy verification and claim-bound recovery

1. Parse `signedTx`; single `CreateContractV2` invoke; single matching auth entry; shared deployer preimage.
2. Derived `contractId` equals body `contractId`; WASM hash equals the pinned hash.
3. **Constructor / wallet init args:** CreateContractV2 constructor must include a GENESIS Secp256r1 signer whose credential id matches `keyIdBase64`. Mismatch → `422 constructor_mismatch` / `invalid_deploy_tx`.
4. Rebuild with `FP_PAYER_DEMO`, simulate. **Before send:** persist on `ClaimLink` `passkeyDeployPendingContractId` (= body `contractId`), `passkeyDeployPendingTxHash`, sealed recovery envelope (`passkeyDeployPendingSealed` / nonce).
5. Send once. On RPC **SUCCESS:** set `passkeyContractId`, `passkeyDeployTxHash`; clear or keep pending fields per implementer; return deploy response.
6. **Restart / lost HTTP:** if `passkeyDeployTxHash` or `passkeyDeployPendingTxHash` is set → **first** `rpc.getTransaction(thatHash)`.
   - **SUCCESS** → return the same `contractId` / deploy hash; **no** new deploy.
   - **PENDING** → wait/poll the **same** hash; do not rebuild.
   - **NOT_FOUND** or **RPC timeout** is **not** FAILED. Restore the sealed envelope for that pending hash and re-query / re-submit **the same** transaction bytes if the network never accepted them; **no blind rebuild**, **no new deploy** with a new hash while the pending binding exists.
   - **FAILED** (proven failed envelope) → only then a documented recovery may build a new tx under a **new** pending hash after clearing the failed pending binding; never while SUCCESS/PENDING/unknown.

### Prepare / secret material / ledger expiry

- Prepare builds vault `claim(id, secret, to=contractId)` auth entries. No `secret` / `secretHex` JSON field.
- **`authEntries` are secret-bearing** (secret in `rootInvocation` args). Seal at rest on `PasskeyClaimPrepare`; never log; never put in IdempotencyRecord.
- **`signatureExpirationLedger`:** one prepare-level value. Backend stamps **every** unsigned auth entry with this ledger. Browser **must** call `signAuthEntry(..., { expiration: prepare.signatureExpirationLedger })`. Kit-default or any other ledger → submit `422 auth_mismatch`. Submit checks each signed entry’s ledger equals the prepare row.

### Submit — reserve, hash-before-send, HTTP 200 vs 202

1. **Atomic reservation:** `PasskeyClaimPrepare` `open → reserved` (`reservedAt`) while claim open and ledger ≤ `signatureExpirationLedger`. Concurrent second reserve → `409`.
2. Validate each `signedAuthEntries[i]`: address, nonce, rootInvocation fingerprint, **signatureExpirationLedger** (length/order). Mismatch → `422 auth_mismatch`.
3. Build release envelope. **Before send:** persist `pendingTxHash` + sealed `pendingTxSealed` / nonce on the prepare row.
4. Send / recover per RPC rules below. **Do not** store a separate prepare `releaseTxHash`.
5. **HTTP responses:**
   - **`200` + `PasskeySubmitResponseSchema`:** only when RPC reports **SUCCESS** for the release and settle **`Leg.releaseTxRef`** is written. Body includes required `releaseTxRef` (= that leg field).
   - **`202` + `PasskeySubmitPendingResponseSchema`:** when the envelope is persisted and/or submitted but release is **not** yet confirmed (`PENDING`, waiting, or re-query after NOT_FOUND/timeout while still bound to the same `pendingTxHash`). Body: `{ status: "pending", prepareId, paymentId, paymentStatus, pendingTxHash }`. **No `releaseTxRef`.** Client must not treat 202 as paid/released; poll `GET /v1/claims/{token}` or retry submit with the same Idempotency-Key.
   - Never return **200** with a required `releaseTxRef` before the release is verified.
6. **Restart / lost HTTP:** if prepare `pendingTxHash` set → `getTransaction` first. SUCCESS → write/read `Leg.releaseTxRef` then **200**; PENDING → **202** (same pending hash); NOT_FOUND/timeout → restore sealed envelope for the **same** hash (not FAILED), respond **202** until SUCCESS or proven FAILED; proven FAILED → documented recovery only. Idempotent HTTP replay uses `IdempotencyRecord` after claim re-validation; cached body must match the outcome (200 vs 202) — never a foreign claim.

### Errors (stable codes)

`404 not_found`; `409 expired` | `invalid_state` | `settle_failed` | `prepare_expired` | `auth_expired` | `idempotency_conflict`; `422 invalid_deploy_tx` | `contract_mismatch` | `wasm_mismatch` | `constructor_mismatch` | `invalid_contract_id` | `auth_mismatch`; `502 deploy_failed` | `prepare_failed` | `release_failed`.

### Persistence

- `ClaimLink` passkey deploy columns + `PasskeyClaimPrepare` (migration `20261025112500_ccr20_passkey_prepare`; historical folder name, CCR-21 content).
- Apply migration only after CCR ACK (or local M2 disposable DB).
- No change to public `ClaimView` shape in this CCR.

### Acceptance (after ACK + implementation)

- Domain contract tests for the three request/response schemas and OpenAPI stubs.
- Testnet: deploy hash + `Leg.releaseTxRef`; vault Claimed to `C…`; evidence without secrets/tokens.
- Manual passkey ceremony on a real authenticator (virtual authenticator is not biometrics proof).

## CCR-22: claim-link reference-anchor HTTP (M1 wiring) — **ACK'd (integrator handoff)**

- **From:** CCR-20 (accepted): “Csaba proposes request shapes in his PR; no additional CCR wait for the three server calls.”
- **Status:** **ACK'd** for M1 API wiring per integrator handoff (Csaba Cursor, branch `event/csaba-cursor/m1-anchor-api`). Adapter client surface remains CCR-20; this CCR is the **public claim HTTP** contract for Csaba ↔ Freebuff/Csenge.
- **Out of scope:** DF7 script, `submitClassicPaymentWithMemo` refactor, SEP-45, changing CCR-20 env names.

### Public routes (`auth: none`, claim token)

| Method | Path | Idempotency-Key | Body | Success |
|---|---|---|---|---|
| POST | `/v1/claims/{token}/anchor/indicative-price` | not used | `{ sellAmount: string }` (USDC major units, 1–10) | `{ indicative: true, context: "sep6", sellAmount, buyAmount, buyAsset, sellAsset, price }` |
| POST | `/v1/claims/{token}/anchor/withdraw` | required | `{ amount?: string, type?: "bank_account" }` — amount defaults to claim settle net; must not exceed net; anchor 1–10 still applies; type only `bank_account` or omitted | **First 200:** `{ anchorTxId, urlSanitised, interactiveUrl, kind: "withdrawal" }`. **Replay 200:** `{ anchorTxId, urlSanitised, kind }` (no `interactiveUrl`). Atomic DB reservation before SEP-24 start — concurrent keys cannot create two sessions. |
| GET | `/v1/claims/{token}/anchor/withdraw/{anchorTxId}` | n/a | — | Read-only: `{ anchorTxId, status, amountIn?, withdrawAnchorAccount?, withdrawMemoPresent, anchorPaymentTxHash?, anchorStellarTransactionId?, vaultReleaseTxRef?, terminal }`. Never pays or starts a session. |
| POST | `/v1/claims/{token}/anchor/withdraw/{anchorTxId}/pay` | required | `{}` | **200** `{ status: "submitted", anchorTxId, anchorPaymentTxHash }` after Horizon accept. **202** `{ status: "pending", anchorTxId, pendingTxHash }` when envelope is retained but outcome uncertain. Uses `buildAndSignClassicPaymentWithMemo` + `submitSignedClassicPayment`; sealed envelope + hash + time bounds persisted **before** send. |

### Sensitive URL / JWT

- `interactiveUrl` may appear **only** on the first successful withdraw HTTP response.
- Full interactive URL / query JWT must **never** be written to DB, logs, payment events, or `IdempotencyRecord.responseBody`.
- Replay/resume returns `urlSanitised` only; do not re-cache a body that still contains `interactiveUrl`.

### Classic pay recovery

- Atomic attempt reservation in DB before signing/submitting.
- Persist sealed signed envelope, hash, and time bounds **before** Horizon submit.
- `NOT_FOUND` / timeout after persist does **not** authorise a new payment — only the same envelope may be resubmitted (within time bounds), per CCR-22 / DF7 recovery rules.
- Keep separate: `Leg.releaseTxRef` (vault), `ClaimLink.anchorPaymentTxHash` (our classic pay), `ClaimLink.anchorStellarTransactionId` (SEP-24 `stellar_transaction_id`).

### Claim / settle connection (Csaba)

1. Claim must be open or accepted after release; settle path may use **anchor vault** via the single `mapAnchorVaultToSettlementEnv` / `createAnchorSettlement` mapping (`FP_ANCHOR_VAULT_*` → settlement factory). Baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` must not mix. Provider registration / routing rewrite remains TBD — no corridor rewrite in this CCR.
2. After vault release to the recipient classic `G…`, server may call withdraw + (custodial) classic memo `/pay`; persist the three refs separately as above.
3. UI copy: “reference anchor on testnet, pays a US-dollar bank account in a sandbox”.
4. Passkey (CCR-21) and anchor (CCR-20/22) remain separate claim options; no SEP-45 in this CCR.

### Errors (stable codes)

`404 not_found`; `409 expired` \| `invalid_state` \| `settle_failed` \| `idempotency_conflict`; `422 amount_out_of_range` \| `anchor_asset_mismatch`; `502 anchor_unavailable` \| `sep24_failed` \| `classic_payment_failed`.

## CCR-23: confirmed deposit + lock recovery (deposit stranded after fee-overflow) — **ELFOGADVA (amended)**

- **From:** M2 fee-overflow evidence (`scripts/demo/evidence/2026-10-25-m2-fee-overflow-*.md`); `executeSettle` in `apps/api/src/orchestrator/run.ts` always `fundVault` then `lock`, bumps `Payment.lockAttempt` before deposit, and **discards** `SettlementAdapter.fundVault`’s `SettlementRef`. Failed `create_payout` after a successful on-chain `deposit` leaves settle `processing` with null `externalRef` / `lockTxRef`; replay bumps attempt and deposits again.
- **Status:** **ELFOGADVA (amended)** — Claude acceptance with the amendments below. This PR remains **documentation only**. **No runtime implementation, no Prisma apply, no shared-DB write, no funding/deposit/lock/release/`/pay`.** Do not replay `pay_b61…` / `pay_a254…`. **Implementation starts only after this PR (#76) is merged by Claude, in a separate implement PR.** Parallel SDK fee build-once work (Csenge Cursor, `event/csenge-cursor/sdk-fee-build`) is **not duplicated** here — CCR-23 consumes its typed fee surface.
- **Does not rename** collect/settle models or CCR-12 fields (`Leg.externalRef` = vault payoutId; `lockTxRef`; `releaseTxRef`).
- **Withdrawn proposals (do not implement):** HTTP `POST /v1/ops/deposits/reconcile`, `FP_OPS_ORG_IDS`, invented domain code `resource_fee_ceiling`, assumed `fundOpIndex = 0`, “data-loss-free” drop of populated fund columns.

### Gap (verified on `origin/main`)

1. `fundVault` already returns `{ network, txRef }` (`packages/domain` + stellar/mock adapters). Orchestrator **does not persist** it.
2. Replay skips deposit only when `leg.externalRef` is set or `findLock(payer, paymentId, lockAttempt)` hits. Fee-overflow / lost lock with **no** on-chain payout → **neither** path applies → **second deposit**.
3. Vault contract errors (`SettlementError` / `VaultError` 1–12) are typed; resource-fee / assemble overflow today often surfaces as a generic string (e.g. `Got 5261104576`). No durable “deposit confirmed” gate exists.
4. There is **no** separate Prisma “fund” leg kind. Funding runs inside **settle** execution. Mapping stays on the **settle** `Leg` (new nullable columns), not a rename of collect/settle.

### 1. Confirmed deposit (settle leg)

After a successful on-chain vault `deposit` and **before** `lock` / `create_payout`, persist on the settle `Leg`:

| Field | Meaning |
|---|---|
| `fundTxRef` | Transaction hash (or mock ref) from `fundVault` → `SettlementRef.txRef` |
| `fundOpIndex` | 0-based operation index of the **decoded** matching `deposit` invoke (never assumed `0`) |
| `fundAmountValue` | Exact deposited minor units (string integer) |
| `fundAmountCurrency` | Settlement asset (e.g. `USDC`) |
| `fundNetwork` | `SettlementNetwork`: `stellar` \| `mock` |
| `fundVaultId` | Vault contract id (C…) or mock vault id used for that deposit |

**Confirmed** means these fields are written only after a successful `fundVault` receipt **and** on-chain (or mock) decode that identifies **exactly one** matching vault `deposit` for the expected network / vault / payer / amount. Unknown historical deposits are **never** auto-marked confirmed (operator local CLI reconcile only — §2).

**Confirmed-deposit replay (§4):** if settle `fundTxRef` is set → **new deposit is forbidden**. Replay uses the **same** `lockAttempt` and derived external id, with existing lock / `findLock` recovery checks. `NOT_FOUND` / timeout do **not** authorise attempt bump or a new deposit.

### 2. Operator-only reconciliation (local CLI)

- **Surface:** operator-only **local CLI** (implement later under `scripts/` — exact command name in the implement PR). **Not** an HTTP ops route. **`FP_OPS_ORG_IDS` is withdrawn.**
- **Behaviour:** given payment id + deposit tx ref (and network as needed), decode on-chain; require **exactly one** matching vault `deposit` (network, vault, payer, amount, successful deposit); reject if multiple matching deposit invokes appear in the tx; bind identity via **DB lock + compare-and-swap** onto the settle leg only when fund columns are still null and the partial unique index allows; write **audit** (and payment event as applicable). Never log secrets.
- **Forbidden:** any public `/v1/claims/*` (or other public claim path) performing deposit reconciliation or binding.

### 3. One deposit → one payment (identity + unique)

A Stellar transaction **may** contain multiple operations. Decode must not treat `fundTxRef` alone as identity.

**Deposit identity:**

```text
(fundNetwork, fundVaultId, fundTxRef, fundOpIndex)
```

- PostgreSQL **partial unique** index on those four columns **`WHERE "fundTxRef" IS NOT NULL`** (global — one deposit cannot fund two payments).
- `fundOpIndex` (and the rest of the tuple) comes from **actual decode**, not a presumed index `0`.
- If decode finds **zero** matching vault deposits → reject bind. If **more than one** matching vault `deposit` invoke → **reject** (ambiguous; no auto-pick).
- Writer/auto-confirm path: if the submitted fund tx decodes to multiple internal vault deposits matching the criteria → **reject** confirm (do not persist fund columns).
- Second payment bind to an already-used identity → reject (unique / CAS failure); stable API/CLI code chosen at implement time without inventing fee-error names.

### 4. Lock recovery (stable attempt / external id)

Counters remain CCR-15: **`Payment.lockAttempt`** drives `sha256("<paymentId>:<lockAttempt>")` / `findLock`; **`Leg.attempt`** is CCR-14 provider retry only.

**After confirmed deposit (`fundTxRef` set), before durable lock (`externalRef` / `lockTxRef`):**

1. Do **not** call `fundVault` (no new deposit).
2. Keep the **current** `lockAttempt` and external id.
3. Run existing lock / recovery checks: `findLock(vaultPayer, paymentId, lockAttempt)` for the current attempt; on hit persist `externalRef` (and `lockTxRef` when available through existing adapter paths) and resume CCR-15; on miss retry `lock` with the **same** attempt only.

**`findLock` NOT_FOUND, RPC timeout, or uncertain lock submit are not proof the attempt is free** — no attempt bump, no new deposit.

### 5. Attempt bump (only verified refunded / cancelled)

`lockAttempt` may increase **only** when **all** hold, under **CAS + audit**:

1. Confirmed deposit already bound to this payment; and
2. On-chain (or mock) proof that the **current** attempt’s payout is **refunded** or **cancelled** (vault terminal state that frees that external id); and
3. Durable audit/event records previous attempt, new attempt, payoutId / external id, and a documented reason for the advance.

Any other failure (fee ceiling, timeout, NOT_FOUND, uncertain submit, generic lock error) **must not** auto-bump. Public `/fund` replay must not bump. Operator CLI may advance only with the same on-chain proof + CAS + audit.

**Discovery of prior successful / uncertain lock:** `findLock` for current attempt; if `externalRef` set, `settlement.status(payoutId)`. Uncertain lock → re-check; never bump; never re-fund.

### 6. Typed fee ceiling — SDK handoff mapping (no invented codes)

**Required env:** `FP_SOROBAN_TX_FEE_CEILING_STROOPS` (stroops, non-negative integer ≤ uint32 max). **No code default.** A local testnet value such as `20000000` may exist only in **local runtime env** — it must **not** be committed as config, `.env.example` fallback, or hard-coded default.

**Typed surface (accepted SDK handoff — do not invent parallel names):** branch `event/csenge-cursor/sdk-fee-build`, module `packages/adapter-stellar/src/vault-tx-fee.ts`:

| Export | Role |
|---|---|
| `SOROBAN_TX_FEE_CEILING_ENV` | `"FP_SOROBAN_TX_FEE_CEILING_STROOPS"` |
| `VaultTxFeeError` | Typed error (`name: "VaultTxFeeError"`) |
| `VaultTxFeeRejectReason` | `missing_built` \| `missing_simulation_data` \| `resource_fee_mismatch` \| `double_counted_resource_fee` \| `fee_exceeds_uint32` \| `ceiling_not_configured` \| `fee_exceeds_ceiling` \| `negative_or_invalid_fee` |
| `parseSorobanTxFeeCeiling` | Missing/blank → `null` (not configured); never invents a default |
| `validateSorobanTxFee` / `rebuildAndValidateVaultWriteFee` | Single-count fee validate + ceiling check; never caps/truncates |

**Orchestrator / API mapping:** propagate `VaultTxFeeError` (at least `reason`, and fee detail fields when present). **Do not** introduce a separate invented domain code such as `resource_fee_ceiling`. Vault contract `FeeTooHigh` (#4) stays distinct from `VaultTxFeeError`.

**Behaviour with confirmed deposit:** on `VaultTxFeeError` during lock (e.g. `fee_exceeds_ceiling`, `fee_exceeds_uint32`, `ceiling_not_configured`, `double_counted_resource_fee`): keep `fundTxRef`; no attempt bump; no new deposit.

**Landed:** `vault-tx-fee.ts` is on `main` (PR #75, merged at `16875c0`). Import `VaultTxFeeError`, `VaultTxFeeRejectReason`, `SOROBAN_TX_FEE_CEILING_ENV` and `parseSorobanTxFeeCeiling` from `@flexipay/adapter-stellar` (`packages/adapter-stellar/src/index.ts`). CCR-23 does not redefine the fee types.

### 7. Migration

See **`docs/DEPOSIT_RECOVERY_MIGRATION.md`** (amended with CCR-23). Nullable settle-leg fund columns + partial unique index; **no** invented confirmed backfill; **backup required** before migrating a DB that holds stranded payments; rollback/restore must **preserve** recovery data (dropping populated fund columns is **not** data-loss-free).

### 8. Targeted tests (implement PR — not this docs PR)

- Confirmed deposit then fund replay → **no** second deposit; **same** `lockAttempt` / external id; existing lock/`findLock` path used.
- Failed lock (no `externalRef`) then replay → stable attempt/external id; lock retried; no new deposit.
- Two payments / binds for the same deposit identity → one rejected (partial unique / CAS).
- Tx decode with **multiple** matching vault deposits → confirm/reconcile **rejected**.
- `VaultTxFeeError` with reason `fee_exceeds_ceiling` (and sibling reasons as applicable) on lock → typed error surfaced; no new deposit; attempt unchanged; `FP_SOROBAN_TX_FEE_CEILING_STROOPS` required (`ceiling_not_configured` when unset).
- Uncertain lock (`NOT_FOUND` / timeout) → no blind new deposit; **no** attempt bump.
- Attempt bump only after on-chain refunded/cancelled proof + CAS + audit; other failures do not bump.
- Local CLI reconcile: lock + CAS + audit; public claim path cannot reconcile.

### Who implements (after #76 merge — separate PR)

- Orchestrator + Prisma + local reconcile CLI: Csaba lane.
- Fee rebuild/validate: consume Csenge `vault-tx-fee` handoff; no duplicate SDK fee surgery.
- No shared-DB migrate without backup (§7 migration doc).

### Closed by this amendment (former open questions)

1. Ceiling env = `FP_SOROBAN_TX_FEE_CEILING_STROOPS` (required; no default). Testnet `20000000` = local runtime only.
2. Reconcile = local CLI only; HTTP ops + `FP_OPS_ORG_IDS` withdrawn.
3. `fundOpIndex` from decode only; multi-deposit match → reject.
4. Historical stranded balances: CLI bind only; withdraw policy remains out of product scope here.

## CCR-24: Solana USDC network + verified wallet transfer (ELFOGADVA — owner TASK 02 authorisation, 31 Oct 2026)

- **Status:** Accepted for implementation on branch `agent/task-02-solana-usdc` under owner authorisation that the November 12 architecture supersedes the EVENT_PLAN “no other-chain adapters” restriction for this task. Stellar and mock settlement remain supported. Integrator review of shared interfaces is not waived.
- **What:** Additive Solana support for wallet-to-wallet USDC on **devnet** (mainnet requires separate approval). Extends crypto `network`, settlement network labels used in fund identity / explorer, claim accept endpoints, and adds verify-before-PAID API routes. Does **not** replace the payment engine, ClaimLink security/expiry/recovery, or Stellar vault adapter.
- **Why:** Demo Day (12 Nov) target is real, verified Solana USDC between supported wallets with receiver-chosen destination via ClaimLink.

### 1. Closed value sets (additive)

| Set | Before | After |
|---|---|---|
| Crypto endpoint `network` | `stellar` only | `stellar` \| `solana` |
| Fiat endpoint `network` | `null` | unchanged |
| `SettlementNetwork` (adapter.network / fundNetwork) | `stellar` \| `mock` | `stellar` \| `mock` \| `solana` |
| Settlement rail config `network` | `stellar` literal | `stellar` \| `solana` |
| Rail id | `stellar_usdc` | add optional `solana_usdc` (config); Solana claim path may still fund via existing mock/stellar settle lock, then complete with verified Solana transfer evidence |

### 2. Claim accept endpoint (§6.3 / CCR-17)

- Crypto endpoints: `network` is `stellar` or `solana`; `country` remains `""`; `details.address` is the destination address string.
- `solana`: address is a base58 Solana pubkey (32-byte ed25519). Validation is length/charset + decode; no private keys.
- `stellar`: existing G… / C… rules unchanged.
- **Accept behaviour when `network=solana`:** persist destination (Endpoint row + durable claim binding), mark ClaimLink `accepted`, **do not** call Stellar vault `release`. Payment stays `processing` until a verified Solana transfer is confirmed. Accepted ≠ paid.
- Fiat / stellar crypto accept paths unchanged.
- Simulated bank/e-wallet options remain in product architecture; UI must not label them LIVE unless a verified provider path exists.

### 3. Solana transfer confirmation API (new)

Auth: `api_key` (sender/platform). Idempotency-Key required on confirm.

| Method | Path | Role |
|---|---|---|
| `GET` | `/v1/solana/config` | Public-safe config: cluster label (`devnet`), USDC mint, decimals, explorer tx URL template, RPC **not** required in browser (web uses Vite proxy or public read RPC configured without secrets). |
| `GET` | `/v1/payments/{id}/solana/intent` | Expected transfer: mint, decimals, amount (minor units string), recipient address, paymentId, cluster. 409 unless claim accepted with solana destination and settle awaiting release evidence. |
| `POST` | `/v1/payments/{id}/solana/confirm` | Body `{ signature: string }` (base58 tx sig). Backend fetches transaction from RPC, verifies **successful** execution, **mint**, **recipient token account owner**, **amount ≥ expected**, and cluster. Only then writes `Leg.releaseTxRef = signature`, marks settle succeeded, payment `paid`. Never marks PAID on submit alone. |

Idempotency: same signature replay returns current paid state; a **different** signature after success → 409. Uncertain confirmation (RPC timeout / missing tx) → 202 pending or 502 without mutating to paid; **no** automatic rebroadcast that could double-spend.

### 4. Persistence (no Prisma migration in this CCR)

- Destination: `Endpoint` with `network="solana"` and `details.address` (existing `String?` / Json columns).
- Evidence: settle `Leg.releaseTxRef` = Solana signature; `fundNetwork` / event payloads may say `solana`.
- A future migration may add `ClaimLink.solanaDestinationAddress` — **out of scope** until separately approved.

### 5. Environment (devnet)

| Name | Role |
|---|---|
| `FP_SOLANA_CLUSTER` | `devnet` (default for TASK 02). `mainnet-beta` forbidden without separate approval. |
| `FP_SOLANA_RPC_URL` | Server-side RPC (e.g. Helius free / public devnet). Never expose API keys to the browser bundle. |
| `FP_SOLANA_USDC_MINT` | SPL mint address. Devnet test mint — UI labels **Devnet USDC (test)**, never mainnet USDC. |
| `FP_SOLANA_EXPLORER_TX_URL` | Optional template with `{signature}` placeholder. |

### 6. Frontend

- Solana Wallet Standard connect/disconnect; show address, SOL balance, USDC (configured mint) balance.
- No private keys or seeds stored by FlexiPay.
- Claim page: Solana destination selection/confirm before sender can pay.
- Payment detail: after solana claim accept, sender signs real transfer; show result + Explorer link after **backend-verified** PAID.
- Crossmint / Phantom Portal / embedded wallets: **not** in this task.

### 7. Tests

- Domain schema: stellar still required where applicable; solana accept parses; invalid address rejected.
- Adapter: verify rejects wrong mint/recipient/amount/failed tx; accepts fixture success.
- API: confirm does not PAID without verify; idempotent confirm; duplicate different sig rejected.
- Web: wallet module unit tests; TASK 01 proxy/client/corridors + CF4 claim regression.
- Demo proof script on devnet when RPC available; otherwise unit/integration with injectable RPC.

### Who implements

- Domain + API + adapter-solana + web: TASK 02 branch owner (this change set).
- No Production deploy; no DB migrate without separate approval.

### CCR-24a (TASK 03): optional `ClaimView.releaseEvidence` — **ACCEPTED (integrator, 2 Nov 2026)**

- **Status:** Implemented on `agent/task-03-live-ui-payment` under CCR-24 §6 (“receiver sees the verified payment result”). Integrator may ACK or rename.
- **What:** `ClaimView` gains optional nullable `releaseEvidence: { network, signature, explorerUrl? }` once settle evidence exists. Public claim GET only; no secrets; no Prisma migration.
- **Why:** Claim page can show Explorer after Solana verify-before-PAID without a second authenticated API.

### CCR-24b (Lane B): Solana verify + settle rail security — **ACCEPTED (integrator, 2 Nov 2026; PR #92, main 4815797)**

- **Status:** Accepted by the integrator after review and a full re-run on the merged result (typechecks, lint, web build, API 123, adapter-solana 9, e2e 78, web 21, browser 138). Not yet proven against live devnet. Amends CCR-24 §§3–5. CCR-24 itself is accepted as amended by 24a and 24b.
- **What (exact contract deltas):**
  1. **F3 verify:** `verifyUsdcTransfer` / `evaluateParsedTransfer` succeed only when the recipient owner’s **configured-mint** token balance increases by ≥ expected minor units. No instruction-parsed fallback. New fail reasons used by API: `wrong_mint`, `missing_reference`, `stale_transaction` (plus existing).
  2. **F4 binding:** On Solana claim accept the API generates a Solana Pay `reference` ed25519 pubkey and stores it on `ClaimLink.solanaPayReference`. `GET …/solana/intent` returns `reference` + `intentIssuedAt` (stamps `ClaimLink.solanaIntentAt` on first call). Transfer builders MUST attach `reference` as a read-only non-signer account key. Confirm verifies reference ∈ tx account keys, refuses any `Leg.releaseTxRef` already used on another payment, and rejects `blockTime < solanaIntentAt` (unix seconds).
  3. **F5 destination:** Solana accept creates an `Endpoint` and stores its id on `ClaimLink.acceptedEndpointId`. Intent/confirm load **only** that endpoint id (never “latest Solana endpoint for recipient”).
  4. **F6 public config:** `SolanaConfigResponse.publicRpcUrl` is `string | null`. Handler returns `cfg.publicRpcUrl ?? null` — never `cfg.rpcUrl`.
  5. **F8 confirm gate:** Before RPC verify, confirm requires claim `accepted`, payment `processing` (not `refunded`/`expired`), settle `processing` with empty `releaseTxRef`. Idempotent replay of the stored signature remains allowed after paid.
  6. **F9 settle rail:** Config adds settlement rail id `solana_usdc` (`network: solana`). `executeSettle` for `rail === solana_usdc` does not call `fundVault`/`lock`. Solana claim accept, if a vault lock exists on the settle leg, **refunds** the pending payout and rewrites the leg to `solana_usdc` with cleared lock/fund refs. Stellar accept / fiat claim paths unchanged.
- **OpenAPI / domain:** Intent schema gains required `reference`, `intentIssuedAt`; config `publicRpcUrl` becomes nullable (breaking for clients that assumed a string fallback).
- **Persistence (migration required):** `ClaimLink.acceptedEndpointId`, `ClaimLink.solanaPayReference`, `ClaimLink.solanaIntentAt` (all nullable); unique partial index `Leg_releaseTxRef_key` on `Leg.releaseTxRef` WHERE NOT NULL. Folder `20261101153000_lane_b_solana_security`. **No down migration.** Do not apply to Neon/production/shared DBs without written integrator approval.
- **Solana USDC mint decimals (quote floor + 422):** FlexiPay domain USDC uses 7 minor decimals; Circle Solana USDC mint uses 6. At quote time, settle principal/net in USDC is floored **down** to a multiple of `10^(7-6)=10` when the settle rail is `solana_usdc` **or** the destination is `crypto_wallet` / `crypto_custodial` (corridors still price `stellar_usdc` first for crypto, then may pay on Solana after claim accept). Examples: `9851485` → `9851480`; `9950000` unchanged. Quoted settle amount equals the Solana transfer amount. `GET …/solana/intent` and confirm map any still-unrepresentable amount to HTTP **422** `amount_not_representable` (not 500). Fiat bank settle routes are not floored.
- **Unresolved architectural decisions (integrator must decide; builders must not silent-pick):**
  1. Claim-link crypto quotes still price `stellar_usdc` first (corridor `settle[0]`); Solana path **refunds after fund** rather than quoting `solana_usdc` from the start. Acceptable interim vs first-class Solana corridor selection?
  2. Unique `releaseTxRef` is **global** (Stellar hashes and Solana signatures share the index). Keep global, or scope to `fundNetwork = solana`?
  3. After Solana accept refund, is any vault fee / collect state reconciliation required beyond clearing settle lock refs?
  4. Should `feeMode` / vault fee still be mandatory on quotes that ultimately settle on `solana_usdc`?
  5. Intent age uses first intent GET clock; should accept time be the bound instead?
- **Who implements:** Lane B (this branch). Mock/Stellar adapters untouched aside from refund-on-Solana-accept.

## CCR-25 (integrator, 3 Nov): claim links outlive their quote

- **Problem:** `claimLink.expiresAt` was copied from `quote.validUntil` (about two minutes), so an invitation expired before the receiver could open it.
- **Change:** `expiresAt = max(quote.validUntil, now + 7 days)` (`CLAIM_LINK_MIN_LIFETIME_MS` in `apps/api/src/orchestrator/create.ts`). The quote still has to be valid at payment creation; only the claim deadline changed. The vault lock expiry follows the claim deadline.
- **Not changed:** quote validity, payment creation rules, API shapes.
- **Status:** accepted (integrator). Tests: API suite 142/142, e2e 78/78; the two expiry tests now advance past 7 days and assert the claim is still open after an hour.

## CCR-26 (integrator, 4 Nov): second Solana settlement asset, tGBP (proposed)

- **Problem:** Solana settlement is USDC only. `usdcMint`/`usdcDecimals` are read from one environment pair, the rail `solana_usdc` is hard-coded in `orchestrator/run.ts` and `orchestrator/solana-claim.ts`, and the domain knows no GBP asset. UK users want to pay and be paid in tGBP (Tokenised GBP, FCA-supervised, native on Solana).
- **Change (proposed):**
  1. A settlement-asset registry (`USDC`, `TGBP`) in `packages/adapter-solana/src/config.ts`: each asset has a mint and decimals from the environment (`FP_SOLANA_USDC_MINT`/`_DECIMALS` unchanged; new `FP_SOLANA_TGBP_MINT`/`_DECIMALS`). TGBP is absent from the registry until its mint is configured, so nothing changes by default.
  2. A new settlement rail `solana_tgbp` in `config/providers.json`, a `GBP` to `TGBP` FX entry at 1:1 with no spread, and `TGBP` in `CURRENCY_DECIMALS`.
  3. The orchestrator picks the Solana rail from the quote's `receiveCurrency` instead of the literal `solana_usdc`.
  4. `GET /v1/solana/config` adds `assets: [{ asset, mint, decimals }]`. `GET /v1/payments/{id}/solana/intent` adds `asset`, `mint` and `decimals`. The existing `usdcMint` and `usdcDecimals` fields stay and, for a USDC payment, equal `mint` and `decimals`; for a TGBP payment they are omitted from use and documented as deprecated. Confirm verifies the balance delta for the payment's own mint only (already mint-scoped).
- **Safety:** mainnet stays blocked unless `FP_SOLANA_MAINNET_APPROVED=1`, which needs Csenge's written approval. The tGBP mint address and decimals must come from the issuer before any mainnet use; on devnet we test with our own test mint that mimics it.
- **Not changed:** USDC behaviour and amounts, claim lifetime (CCR-25), auth modes, error statuses.
- **Direction (Csenge, 4 Nov):** pounds are the main focus from now on; USDC stays as a second asset.
- **Facts from tokenisedgbp.com (4 Nov, issuer's own pages):** native on Solana, Ethereum, Base, Arbitrum, Polygon, BNB Chain, Gnosis Chain and Avalanche. Solana mint address listed there: `2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW` (still verify against the issuer's contract register before any mainnet use). Decimals, fees, minimums and settlement times are not stated. The issuer is FCA-registered as a crypto asset firm; tGBP is not e-money and not FSCS-protected. Eligible businesses mint over Faster Payments or CHAPS after onboarding; institutions go through the Archax platform. Listed on Kraken, Coinbase and Bitpanda; Coins.ph and Wirex are named as remittance partners.
- **Open questions for the issuer:** official Solana mint address, decimals, whether FLEXIWORK LTD can mint and redeem through Faster Payments, and fees.
- **Who implements:** integrator (API, domain, adapter); Cursor follows with the web screens once the API lands.
- **Implemented (not merged; PR on branch `feat/ccr-26-tgbp`):**
  - `packages/adapter-solana`: `assets` registry on `SolanaRuntimeConfig` (USDC always; TGBP only when `FP_SOLANA_TGBP_MINT` is set, decimals from `FP_SOLANA_TGBP_DECIMALS`, default 6, unconfirmed with the issuer), `solanaAssetConfig()`; verify error texts no longer say "USDC".
  - `packages/domain`: `GBP` (2) and `TGBP` (7) in `CURRENCY_DECIMALS`; `floorMinorForSolanaMint()` (USDC helper unchanged); `solana-assets.ts` (`solanaRailForAsset`, `isSolanaSettleRail`); the Solana mint floor now also applies to TGBP; a domestic corridor with a settle rail routes collect, convert, settle; config validation allows a crypto-only domestic corridor and skips rate checks for same-currency pairs.
  - `config/`: rail `solana_tgbp`, GBP>TGBP and TGBP>GBP rates at 1.0000000, simulated providers `sim_bank_gb_fps` (collect) and `sim_fx_gbp_tgbp` (0 fee, 0 bps spread), new corridor `GB-GB` (GBP in, `crypto_wallet` only, settle `solana_tgbp`).
  - `apps/api`: orchestrator treats `solana_usdc` and `solana_tgbp` alike and keeps the payment's own rail on claim accept; claim accept for a TGBP payment requires network `solana` and currency `TGBP` (422 `endpoint_mismatch`); `GET /v1/solana/config` adds `assets`; intent adds `asset`, `mint`, `decimals` (and `usdcMint`/`usdcDecimals` equal to them, deprecated); intent and confirm pick the asset from the quote's receive currency (422 `unsupported_asset` when not configured); `openapi.json` regenerated.
  - Tests: adapter config registry, GB-GB routing (receive in TGBP, no FX spread, mint floor), TGBP intent/confirm with the stubbed verifier, USDC behaviour unchanged.
- **Status:** implemented, not merged. Real tGBP use needs the issuer's confirmed mint address and decimals, and mainnet needs Csenge's written approval (`FP_SOLANA_MAINNET_APPROVED` stays unset).

## CCR-27 (integrator, 5 Nov): payment requests and the till QR (proposed)

- **Why:** UK hospitality and retail users (FLEXIWORK's own customers) want a QR at the till. The customer scans it with any Solana wallet and pays in pounds (tGBP); the merchant sees "paid" on a screen. FlexiPay does not hold the money: it goes wallet to wallet.
- **Design:** reuse the existing quote, payment, claim and Solana verification machinery. A new endpoint chains the existing steps server-side for one merchant request, and a status endpoint finds the customer's transfer on-chain by its Solana Pay reference.
  1. `POST /v1/payment-requests` (auth: customer, key or session). Strict body: `amount` (GBP minor units as a string, the amount the merchant receives, 100 to 1,000,000), `merchantWallet` (base58 Solana address), optional `label` (1 to 40 characters). Internally: quote on the GBP to TGBP crypto-wallet corridor with the **receive** side set to the request amount, create the payment (claim link, token discarded), fund (simulated collect, labelled simulated), and accept the claim to `merchantWallet` (existing Solana accept, which binds the Solana Pay reference). Returns 201: `{ id (payment id), status, amount { amount, currency: "TGBP" }, merchantWallet, reference, solanaPayUrl, expiresAt }`.
  2. `GET /v1/payment-requests/{id}` (auth: customer). Returns the same shape plus `status` (`waiting`, `paid`, `expired`) and, when paid, `signature` and `explorerUrl`. While `waiting` and before `expiresAt`, it looks up transactions that include the reference (`getSignaturesForAddress`, newest first, at most 5), verifies the first candidate with the existing balance-delta check (mint, amount, recipient, reference, not before intent time) and completes settlement through the existing code. Look-ups are rate-limited per request (at most one RPC look-up every 2 seconds).
- **Solana Pay URL:** `solana:<merchantWallet>?amount=<decimal tokens>&spl-token=<mint>&reference=<reference>&label=<label>&message=Pay%20%C2%A3<amount>`. Wallets use the network they are set to; on devnet the customer's wallet must be set to devnet.
- **Expiry:** 15 minutes from creation (`expiresAt`). After that the request is `expired` and never settles.
- **Fees:** the on-chain amount is exactly the requested pound amount (receive side). FlexiPay's fee stays simulated off-chain, as in every other payment today. Real fee collection is a separate decision.
- **Errors:** only existing statuses: 422 `validation_error` for a bad body, 404 `not_found` for another organisation's request, 422 `unsupported_asset` when tGBP is not configured.
- **Not changed:** existing payment, claim and Solana routes and their behaviour; no schema change expected (if one is needed the implementer stops and reports).
- **Who implements:** API by the integrator (via a background agent); the "Take payment" screen by Cursor against this contract; QA with Playwright (API replay script and mocked UI) and one real device test by Csenge on devnet.
- **Implemented (not merged):**
  - `packages/domain/src/api/payment-requests.ts` (strict schemas), `apps/api/src/routes/payment-requests.ts` (both routes), `apps/api/src/solana/reference.ts` (reference look-up, throttle, test hooks), `apps/api/src/solana/pay-url.ts` (Solana Pay URL), `adaptersOf` exported from `routes/claims.ts` (no behaviour change), `apps/api/openapi.json` regenerated, `apps/api/test/payment-requests.test.ts` (9 tests).
  - The request is stored as an ordinary payment (no schema change): `reference` is `preq:<label>`, the recipient is one shared company recipient "Payment requests (till)" per organisation, and the requested pounds are the quote's receive-side amount (`quote.amountValue`).
  - **Decision recorded:** the on-chain amount verified is exactly the requested pounds (receive-side target), not the quote's solved `expectedReceive`. The receive-side solver works in whole pence and a 1% fee, so for most amounts (for example £10.50) `expectedReceive` differs from the target by under 1p, and a customer cannot be asked to pay £10.50495. The vault fee stays simulated and off-chain, as everywhere else. `feeMode` is `PayerPays` (the fee sits on the payer's side, so the receive side is the requested amount); `RecipientPays` would have deducted the fee from the merchant.
  - Look-up failures are a 502 `rpc_error`; a signature already used by another payment is skipped.
  - Expiry (15 minutes) is evaluated on read; an expired request is reported `expired` and never settles, but its underlying payment is left as it was (a later clean-up job or the existing cancel route can close it).
- **Status:** implemented, not merged.
- **Addendum (6 Nov, PR #150):** `PaymentRequest` gains optional `payer` (the paying wallet from the verified transfer, read from the `payment.onchain` event; `null` when unknown). Additive, no status change; `openapi.json` regenerated.

## CCR-28 (integrator, 6 Nov): aggregator, best quote per leg

- **Why:** FlexiPay aggregates payout and ramp partners and must show the best quote. Until now the router took the first healthy provider in `legsAvailable` order, so a second partner could never win on price.
- **Change:** `packages/domain/src/routing/price.ts` quotes every eligible and healthy provider on a collect, convert or payout leg and keeps the one whose `amountOut` is highest. A tie keeps the provider listed first. A provider whose quote throws (for example below its minimum) is skipped with a reason; if every provider throws, the first error is returned as before. When more than one provider quoted, the quote's `reasons` gain "Best <leg> quote: <id> delivers <amount> (others: ...)".
- **Greedy by leg:** each leg is chosen on its own output, in order. A joint search across legs (for example a direct tGBP payout beating tGBP to USDC to local) is a later step; routes that avoid a conversion are added as separate route templates, not by this change.
- **Not changed:** corridors, config format, route templates, settle and vault pricing, fee modes, error statuses, API shapes, `openapi.json`. A corridor with one provider per leg returns exactly the same quote as before (all existing routing tests pass unchanged).
- **Adding a partner:** a provider entry in `config/providers.json`, an adapter registered with the API, and its id appended to the corridor's `legsAvailable`. A corridor is labelled live only after an end-to-end test passes (docs/PROVIDERS.md).
- **Tests:** `packages/domain/test/aggregator.test.ts` (8): single provider unchanged, best wins with a reason, primary kept when cheapest, config order does not matter, tie keeps the first, a down provider is skipped, a provider that cannot quote the amount is skipped, all failing returns the original error.
- **Status:** implemented on branch `claude/aggregator-best-quote`, not merged.


## CCR-29 (integrator, 6 Nov): partner adapters (BlindPay first), off-ramp pairing, partner polling

- **Why:** the aggregator (CCR-28) needs real partners, and real payouts finish later, not at once. The first partner, BlindPay, converts USDC to local currency and pays the bank in one step, which the per-leg router could not represent.
- **Config:** `config/providers.json` rows gain an optional `implementation` (`sim`, `blindpay`, `tazapay`; omitted means `sim`). The simulated registry skips partner rows. A partner row keeps `simulated: true` while it runs on a sandbox (no real money moves); its `fee` and `fxSpreadBps` are unused because the partner quotes its own price.
- **Adapters:** new package `@flexipay/adapters-live`. `createLiveProviders(config, env)` registers a partner only when its keys are set; a partner row without keys is left out of routing silently (no reason noise). The API looks up partner adapters first, then simulated ones.
- **BlindPay (`blindpay_sandbox`):** env `BLINDPAY_API_KEY`, `BLINDPAY_INSTANCE_ID`, and for payouts `BLINDPAY_SANDBOX_CUSTOMER_ID`, `BLINDPAY_SANDBOX_BANK_ACCOUNT_ID`, `BLINDPAY_SANDBOX_WALLET_ID`. Convert is priced from BlindPay's FX quote (`POST /v1/instances/{id}/quotes/fx`, fee expressed in USDC); executing it only records the step. Payout creates a BlindPay quote for the exact local amount and executes it from the BlindPay-managed sandbox wallet (`POST /quotes`, `POST /payouts/evm`), topping up test USDB on development instances. Status maps `completed` to succeeded, `failed`/`refunded` to failed, `processing`/`on_hold` to processing. A production instance is refused unless `FP_BLINDPAY_LIVE_APPROVED=1`, which needs the owner's written approval. **Sandbox limit:** every payout goes to the configured sandbox bank account; paying a real recipient needs a BlindPay customer and bank account per recipient (later work).
- **Off-ramp pairing (routing):** a provider serving both `convert` and `payout` is an off-ramp. The convert + payout tail is priced as a pair: the off-ramp doing both legs competes with the best plain convert followed by the best plain payout, on what the recipient receives; a tie keeps the plain route. An off-ramp never serves a lone leg (for example the convert before settle). Reason: "Best payout route: <id> delivers <amount> (others: ...)".
- **Processing legs:** the leg runner now stops at a non-settle leg that is `processing` with a partner reference, instead of re-polling in a tight loop. A retry (CCR-14) clears the reference and still runs on. New `apps/api/src/ops/provider-poller.ts` resumes such payments every 15 seconds (started only when a partner is registered).
- **Corridor:** `blindpay_sandbox` added to US to BR convert and payout. More corridors (MX, CO, AR, GB to abroad) follow once their quotes are checked.
- **Tests:** domain 95 (3 new pairing tests), adapters-live 12 (fake BlindPay API), API 162 (1 new: processing partner leg waits, poller completes it). Sandbox check by the integrator on 6 Nov: development instance, 10 USDB quoted to R$54.43 by Pix, payout completed in about 10 seconds.
- **Not changed:** API shapes, `openapi.json`, error statuses, settle and vault pricing.
- **Status:** merged in #151 (6 Nov). Live sandbox check on 6 Nov: payment `pay_602f55385a7c85b8e25d8694`, US to BR $20 quoted R$107.33 via `blindpay_sandbox`; collect, convert, settle and the BlindPay convert succeeded at funding, the BlindPay payout was `processing`, and the poller marked the payment `paid` within 15 seconds. Live Playwright `tests/e2e-live/tests/live-aggregator.spec.ts` passes (7/7 live tests).

## CCR-30 (builder + integrator, 6 Nov 2026): Tazapay off-ramp adapter, GB-PH corridor

- **What:** `TazapayAdapter` in `@flexipay/adapters-live`, registered by `createLiveProviders` for rows whose `implementation` is `"tazapay"`, only when `TAZAPAY_API_KEY` and `TAZAPAY_API_SECRET` are set. Sandbox row `tazapay_sandbox` (PH, bank accounts, `convert` + `payout`, inputs GBP/TGBP/USD/USDC, payout PHP) joins US-PH and the new **GB-PH** corridor.
- **Model: off-ramp (CCR-29 pairing), corrected by the integrator after a sandbox check.** The builder's first version treated Tazapay as a plain PHP payout from a PHP balance. The sandbox refuses a PHP holding balance (error 20168); Tazapay holds GBP, USD, EUR or SGD and converts inside the payout. So, like BlindPay, it serves the convert + payout pair: convert is priced by `POST /v3/payout/quote` with `holding_info.amount` (the quote's `payout_info.amount` is already net of Tazapay's fee) and executing it only records the step (`tazapay-convert:<holding>:<legId>:<attempt>`); payout is a pass-through priced at 0 and executes `POST /v3/payout` from the holding balance. Input mapping: GBP and TGBP hold GBP; USD and USDC hold USD (FlexiPay funds the balance by off-ramping the stablecoin; tGBP off-ramp is free per tGBP). The payout uses the holding currency recorded at convert time, else `TAZAPAY_HOLDING_CURRENCY` (default USD).
- **Sandbox facts (6 Nov):** every success is wrapped in `{status, message, data}`; amounts are hundredths of every currency (VND and IDR included); quotes come back already `expired`, so the payout is created without `quote`; passing `local.fund_transfer_network` is refused (20436), so it is omitted. £100 held quoted ₱7,853.81 after a £4.08 fee at 81.8779. GBP quotes also work for BRL, MXN, NGN, KES, INR, VND and IDR (coverage for later rows). A payout needs a funded sandbox balance (dashboard: activate a collection account, then Simulate Collect).
- **Routing change:** `pricePayoutPair` passes the payout endpoint (country) to the off-ramp's convert quote. Plain providers ignore it.
- **GB-PH corridor:** collect `sim_bank_gb_fps` → convert `sim_fx_gbp_tgbp` → settle `solana_tgbp` → convert/payout (Tazapay pair, or simulated FX + InstaPay/e-wallet). Bank account and e-wallet only: tGBP to a wallet stays on GB-GB, so a country-less wallet request is not ambiguous. Placeholder sim rates TGBP>PHP 75 and PHP>GBP 0.0133333 added for the simulated alternative and fee totals.
- **Status:** `GET /v3/payout/{id}`; `succeeded` → succeeded; `failed`, `cancelled`, `reversed` → failed (`provider_down`); funding, confirmation, action, approval and hold states → processing; unknown → processing; 404 → `unknown_reference`. Sandbox payouts move to succeeded on their own.
- **Reversal:** the convert record reverses (nothing moved); payouts are `not_reversible`.
- **Health:** cached 60 s, `GET /v3/metadata/payout/bank` for the row's first country and payout currency.
- **Environment:** `TAZAPAY_API_KEY`, `TAZAPAY_API_SECRET`; optional `TAZAPAY_BASE_URL`, `TAZAPAY_SANDBOX_BENEFICIARY_ID`, `TAZAPAY_PURPOSE_CODE` (default `PYR001`), `TAZAPAY_HOLDING_CURRENCY`. Production URL refused unless `FP_TAZAPAY_LIVE_APPROVED=1`.
- **Tests:** adapters-live 25 (13 Tazapay, fake API built from real sandbox responses); domain 95; API 162; e2e-ui 102. Local check through the real router and sandbox: £100 GB-PH bank → ₱7,771.93 via Tazapay (simulated alternative ₱7,372.88); $100 US-PH → ₱5,699.72 via Tazapay; $100 US-BR still BlindPay.
- **Not confirmed:** a completed sandbox payout (balance is 0 until the dashboard collect is simulated); real recipient beneficiaries (payouts go to one sandbox beneficiary until EndpointRef carries bank details).

## CCR-31 (integrator, 6 Nov 2026): GBP to 62 more countries through Tazapay

- **What:** 62 new corridors `GB-XX` (bank accounts, individual and company), each collect `sim_bank_gb_fps` → convert `sim_fx_gbp_tgbp` (GBP to tGBP) → settle `solana_tgbp` → Tazapay convert + payout from a GBP balance. With GB-PH that is 63 destination countries from pounds. `tazapay_sandbox` lists the countries and payout currencies; PH and PHP stay first (health check).
- **How the list was made:** every country where Tazapay's sandbox reports a local payout rail (71) was quoted £100 from a GBP balance in its national currency on 6 Nov. Included: every country that quoted, except GB and US (US payout is USD, which Tazapay holds, not pays) and Costa Rica (the sandbox returned a negative fee). Left out: BF, BJ, SN, TG (XOF) and CM (XAF), which the sandbox refused at £100 for min/max limits.
- **Currencies:** ISO minor units added to `CURRENCY_DECIMALS` (CLP, KRW, UGX, VND, ISK at 0; the rest 2). Tazapay itself counts every currency in hundredths; the adapter rescales.
- **Rates:** placeholder `TGBP>XX` and `XX>GBP` rates from Tazapay's sandbox rate, needed by the config validator and for fee totals. They never price a route: these corridors have no simulated payout, so the only route is the Tazapay pair, priced live.
- **Web:** `countryLabel` falls back to `Intl.DisplayNames`; destination countries are sorted by name.
- **Not confirmed:** payouts outside PH (the single sandbox beneficiary is in PH; payouts to other countries need recipient bank details passed to Tazapay, next CCR); XOF/XAF at higher amounts.

## CCR-33 (integrator, 6 Nov 2026): vault lock and partner legs

- **Found live:** payment `pay_060e5d3a850398f3a36aafdc` ($200 US-PH): Tazapay paid ₱11,734.04 in about two minutes, but the final vault release failed with `settlement error #8 Expired` (the lock expires with the quote, 120 s) and the payment stayed `processing`; the poller never picked it up again because no leg was processing.
- **Change 1:** before a pending partner leg runs (`OrchestratorAdapters.partnerProviderIds`, filled from `liveProviderIds`), the orchestrator releases the pending settle lock. A partner payout is not reversible, so holding the lock until it finishes protected nothing. Simulated routes keep the old order (release at the end, refund on payout failure).
- **Change 2:** `releasePendingSettle` refunds a lock that expired before release (back to FlexiPay's vault payer) and emits `payment.onchain` `refund_after_expiry`, instead of throwing on every pass.
- **Change 3:** the provider poller also resumes `processing` payments whose legs have all succeeded.
- **Tests:** API 164 (2 new: release before the partner leg; expired lock refunded, payment paid, poller finds it).

## CCR-32 (builder, 6 Nov 2026): recipient bank details to partner beneficiaries

- **What:** bank-account endpoints may carry the details a partner needs to create a beneficiary. `EndpointRef` passed to `execute()` may carry the endpoint's unmasked `details`, the recipient's `name` and `kind`, and `partnerRefs` loaded from the DB. The orchestrator fills them from the accepted claim endpoint or from `Payment.endpointId` (stored for each batch row); direct payments without a linked endpoint keep their existing `quote_dest` reference.
- **Details contract:** `accountNumber` stays required. `accountHolderName`, `bankName`, `swiftCode`, `iban`, `bankCode` and `branchCode` are optional strings. Responses still use the existing mask (`maskDetails`: last four characters visible). The new keys are never added to `EndpointSchema`; only the stored endpoint's `details` object widens.
- **Persistence:** nullable `Endpoint.partnerRefs` JSON and nullable `Payment.endpointId` (migration `20261106120000_ccr32_endpoint_partner_refs`). A partner adapter may return `partnerRefs` from `execute()`; after the leg reference is stored, the orchestrator merges them into the endpoint. `partnerRefs` is never serialized into payment, event or API responses; `Payment.endpointId` is internal and not added to the payment API schema.
- **Tazapay:** before creating a beneficiary, `GET /v3/metadata/payout/bank?country=XX&currency=YYY` supplies `required_bank_fields` and `required_bank_codes`. Missing values throw `ProviderError` `unsupported` naming the FlexiPay keys and the Tazapay field names; no request is sent with partial details. `POST /v3/beneficiary` sends `{ name, type: individual|business, email, destination_details: { type: "bank", bank: { account_number, country, currency, account_holder_name, bank_name, bank_codes } } }`; the returned `data.id` (`bnf_...`) is persisted as `partnerRefs.tazapay_beneficiary_id` and reused. `company` maps to `business`. The contact email defaults to the non-routable sandbox placeholder `sandbox@flexipay.test`, overridable with `TAZAPAY_BENEFICIARY_EMAIL`.
- **Fallback:** `TAZAPAY_SANDBOX_BENEFICIARY_ID` is used only on the exact sandbox URL and only when the endpoint has no bank details. Production and custom URLs refuse instead. A payout still sends no `quote` and no `local.fund_transfer_network`; amounts stay hundredths of every currency.
- **Sandbox fixtures:** beneficiary creation and payout fixtures avoid the sandbox ranges 200000-250000 (fail) and 500000-600000 (reverse).
- **Tests:** adapters-live fake API covers beneficiary create once/reuse (including a fresh adapter using the persisted ref), exact request body, missing-field refusal, sandbox-only fallback, no console logging, and unchanged payout/idempotency behaviour. API covers optional detail keys still masked on read, the orchestrator passing unmasked details plus recipient identity from the DB to the payout adapter, persisting returned partner refs, and batch payments storing their endpoint. Domain covers the widened endpoint schema.
- **Not confirmed:** a live beneficiary/payout to a real recipient (no Tazapay keys here); the contact email is a sandbox placeholder, and production needs a verified recipient email source before approval.
- **Status:** implemented on branch `feat/ccr32-recipient-bank-details`, not merged.

## CCR-34 (builder, 6 Nov 2026): BlindPay recipient bank accounts

- **What:** when a BlindPay payout leg carries an `EndpointRef` with bank details, the adapter creates a BlindPay bank account once for that FlexiPay endpoint and reuses it. The account id and the KYC-approved receiver id are returned from `execute()` as `partnerRefs` (`blindpay_bank_account_id`, `blindpay_receiver_id`); the orchestrator already persists those refs on the endpoint (CCR-32). A fresh process reuses the persisted account instead of creating a second one. Corridors: BR (Pix), MX (SPEI), CO (ACH COP) and AR (Transfers 3.0).
- **Receiver/KYC blocker:** a BlindPay bank account belongs to a BlindPay customer/receiver. Creating one requires `tos_id`, customer type and KYC type, email and address, tax id, date of birth, and identity documents (`id_doc_type`, `id_doc_country`, `id_doc_front_file`, `selfie_file`); see https://blindpay.com/docs/learn/customers and https://blindpay.com/docs/getting-started/quick-start. FlexiPay stores none of that, so this change **does not create customers and does not invent KYC data**. A payout with bank details but no `endpoint.partnerRefs.blindpay_receiver_id` fails before any bank-account request with a `ProviderError` naming the missing KYC fields. The receiver must already exist after BlindPay's KYC onboarding; there is currently no public API route that writes `partnerRefs`, so an operator/onboarding flow must set that ref before live use.
- **Bank-account endpoint:** `POST /v1/instances/{instance_id}/customers/{customer_id}/bank-accounts`, with `Authorization: Bearer <key>` and a deterministic `Idempotency-Key: flexipay-bank-account-{endpointId}`. The response `id` is the `ba_...` id used by the payout quote. Docs: https://blindpay.com/docs/bank-accounts and https://api.blindpay.com/doc. Every request uses `bank_account_id` in `POST /v1/instances/{instance_id}/quotes` and the existing `POST /v1/instances/{instance_id}/payouts/evm`; see https://blindpay.com/docs/payouts.
- **Detail keys:** CCR-17 bank details now also accept `pixKey`, `clabe`, `speiProtocol`, `speiInstitutionCode`, `firstName`, `lastName`, `documentId`, `documentType`, `email`, `accountType` and `transfersType`. All are optional strings; `accountNumber` stays required. Responses still mask every detail value with the existing `maskDetails` logic.
- **Per-country mapping** (required fields from https://blindpay.com/docs/bank-accounts#required-fields-per-type):

  | Country | BlindPay type | FlexiPay details -> BlindPay fields |
  | --- | --- | --- |
  | BR | `pix` | `recipientName`/`accountHolderName` -> `name`; `pixKey` -> `pix_key` |
  | MX | `spei_bitso` | `recipientName`/`accountHolderName` -> `name`; `accountHolderName` -> `beneficiary_name`; `speiProtocol` -> `spei_protocol` (`clabe`, `debitcard` or `phonenum`); `clabe` -> `spei_clabe`; `speiInstitutionCode` -> `spei_institution_code` (required for `debitcard`/`phonenum`) |
  | CO | `ach_cop_bitso` | `recipientName`/`accountHolderName` -> `name`; `firstName`, `lastName`, `documentId`, `documentType` (`CC`, `CE`, `NIT`, `PASS`, `PEP`), `email`, `bankCode`, `accountNumber`, `accountType` (`checking` or `saving`) |
  | AR | `transfers_bitso` | `recipientName`/`accountHolderName` -> `name`; `accountHolderName` -> `beneficiary_name`; `transfersType` (`CVU`, `CBU` or `ALIAS`) -> `transfers_type`; `accountNumber` -> `transfers_account` |

- **Refusal:** missing or invalid bank fields throw `ProviderError` `unsupported` naming the FlexiPay key and the BlindPay field, with the required-fields documentation URL. No bank-account request is sent with a partial body.
- **Fallback:** `BLINDPAY_SANDBOX_BANK_ACCOUNT_ID` is used only on a BlindPay `development` instance and only when the leg has no endpoint bank details. A production instance refuses instead. The sandbox account is never used to stand in for missing fields on an endpoint.
- **Tests:** fake BlindPay API covers create-once/reuse across a fresh adapter, both returned refs, exact BR/MX/CO/AR request bodies, missing KYC receiver refusal, missing bank-field refusal, development-only sandbox fallback, no console logging of details, and the existing payout/idempotency path. Domain covers the new detail keys; API covers the new key still being masked on read.
- **Verification:** domain 97, adapters-live 35, API 166, web 104, e2e-ui 109 passed; workspace typecheck, lint, OpenAPI regeneration and the production build passed.
- **Not confirmed:** no live BlindPay keys, receiver KYC onboarding or real bank account was exercised. Third-party bank accounts may require relationship/compliance documents and some countries restrict them (https://blindpay.com/docs/payouts); an account under a customer that is not the payout party needs compliance review before production.
- **Status:** implemented on branch `feat/ccr34-blindpay-beneficiaries`, PR open against `main`, not merged.

## CCR-36 (integrator, 7 Nov 2026): a partner refusal fails the leg; Tazapay name rule

- **Found live (Task 24 live test):** Tazapay refused the beneficiary for "Live QA Maria 1794046661872" (HTTP 400 "valid beneficiary name"). The `ProviderError` escaped `executeLeg`, the fund call failed, and the payout leg stayed `processing` with no reference: the poller never saw it and nothing was refunded.
- **Change 1 (orchestrator):** a `ProviderError` thrown by `provider.execute()` means the partner refused before creating anything, so the leg fails through `onProviderLegFailed` and the CCR-14 retry/refund rules run. Any other error (for example a timeout, where money may have moved) still propagates.
- **Change 2 (Tazapay):** sandbox check 7 Nov: names with digits or over 140 characters are refused; accents, hyphens, apostrophes and full stops are accepted. The adapter refuses such a recipient or account holder name before calling Tazapay, naming the rule.
- **Change 3 (web):** Payment detail reloads the payment after a failed Fund, so it never shows a stale "Awaiting funding".
- **Tests:** API 167 (1 new), adapters-live 37 (1 new), web 107, e2e-ui 114.
- **Follow-up (same day):** the first version stored `externalRef: ""` on the refused leg; `PaymentDetailSchema` needs a non-empty string or null, so `GET /v1/payments/{id}` threw and answered 404 (found on the live QA payment `pay_5057866cc0a9d27973bf72ab`). A refused leg now stores null and its `leg.failed` event leaves `externalRef` out; the serializer maps any stored "" to null, which also repairs that row without a manual DB write.
- **Known gap:** when a partner leg fails after CCR-33 released the vault lock, the settle refund cannot come from the vault (`refund_failed` on the live QA payment). Refunding a partner-route failure needs a FlexiPay treasury refund path (follow-up).


## CCR-35 — never route money to a partner that cannot pay it

*Status:* implemented on branch `feat/ccr35-partner-balance-guard`, PR against `main`, not merged. Tazapay's live payout balance is now part of quoting and execution.

- `TazapayAdapter.quote` (convert) reads `GET /v3/balance` and caches the available balances for
  60 s. If the holding currency cannot cover the quoted holding amount plus Tazapay's fee, it
  throws `ProviderError("insufficient_partner_balance", "Tazapay GBP balance too low for this
  payout")`. The router records that reason and tries the other eligible routes.
- `TazapayAdapter.execute` re-reads the balance immediately before `POST /v3/payout` (bypassing
  the cache). A short balance fails the leg with the same code before Tazapay can answer 20199.
- `GET /v1/ops/partners` (same `api_key` auth as the operator routes) returns each registered
  partner's `id`, `label`, `mode` (`sandbox`/`live`), `health`, Tazapay's `balances` by currency,
  and BlindPay's `instanceType`. It does not expose keys, account numbers or recipient data.
- `TAZAPAY_LOW_BALANCE_ALERT` (default `50000` hundredths) logs one line when a Tazapay currency
  crosses below the threshold; it contains no customer amounts or secrets.
- The shared CCR-36 `ProviderError` path treats `insufficient_partner_balance` as a failed leg and
  emits `leg.failed` with the stable code, so the existing retry/refund policy can run.

*Tests:* `packages/adapters-live/test/tazapay.test.ts` covers a short quote, the 60 s cache and
single low-balance warning, and the pre-payout refusal against the fake API;
`apps/api/test/ccr35-partners.test.ts` covers the route shape, API-key auth, and absence of
secrets. Verification: domain 98, adapters-live 40, API 169, web 107, e2e-ui 114; workspace
typecheck, lint, the production build and OpenAPI regeneration passed. `apps/api/openapi.json` is
generated from the route table.
- **Integrator addition (7 Nov):** `GET /v1/ops/partners` used `api_key` auth, which every customer organization has, so any API customer could read FlexiPay's partner balances. It now answers only for organizations listed in `FP_OPERATOR_ORG_IDS` (comma-separated) and is 404 for everyone else; unset means closed. Tazapay 4xx replies are `ProviderError` (20199 → `insufficient_partner_balance`) and an unreadable balance before a payout refuses cleanly (CCR-36).

## CCR-38 (integrator, 7 Nov 2026): quote alternatives carry the losing payout options

- **Found live:** `Quote.alternatives` was always `[]` (hard-coded in `assembleQuote`); the partner comparison lived only in the reasons text, so the Task 26 saving (#168) could never appear on a live quote.
- **Change:** `pricePayoutPair` returns the losing convert + payout options; `priceRoute` turns each into a full alternative route (same legs before the pair, the losing pair after), totals its fees with the same `sumFeesTotal`, and returns them best first. Reasons read "Via <label>: delivers <amount> <currency>". Routes without a pair comparison keep `alternatives: []`. No API shape change.
- **Tests:** domain 99 (1 new: the alternative equals the plain-route quote exactly), API 171, web 111, e2e-ui 118; live BR test now checks the saving line.

## CCR-39 (builder, 7 Nov 2026): direct Solana settle to FlexiPay treasury

- **Problem:** `GET/POST /v1/payments/{id}/solana/intent|confirm` required a claim-accepted Solana destination. Direct GB→abroad bank routes (`delivery=direct`, settle `solana_tgbp`, convert+payout after) have no claim destination, so intent was 409 while settle waited on `solana_settle_wait`.
- **Env:** `FP_SOLANA_SETTLE_TREASURY` — Solana owner address the sender pays. Unset / invalid → 409 `invalid_state` "Solana settle treasury not configured" for **direct** routes only. Claim-link intent/confirm unchanged.
- **Direct route:** `delivery=direct`, settle rail is `solana_*`, settle `processing` with no `releaseTxRef`, and at least one leg after settle.
- **Intent (direct):** `recipient` = treasury; `reference` = per-payment Solana Pay pubkey (generated once, stored on `Payment.solanaPayReference`); `intentIssuedAt` stamped once on `Payment.solanaIntentAt`; `asset`/`mint`/`decimals` from the **settle rail** (TGBP for `solana_tgbp`, not `quote.receiveCurrency`); `amount` = settle `amountIn` floored with `floorMinorForSolanaMint` then converted to mint minors.
- **Confirm (direct):** `verifyPaymentTransfer` against treasury + stored reference + amount + `notBefore=intentAt`; same reuse / 202 pending / 502 rpc / 422 not-verified / idempotent replay guards as claim-link. On success: settle `releaseTxRef=signature`, then `fundAndRun` with the fund route's adapters (including `partnerProviderIds`) so convert+payout continue.
- **Response:** `SolanaConfirmResponseSchema.paymentStatus` is `paid | processing` (claim-link crypto stays `paid`; direct abroad is often `processing` until Tazapay finishes). OpenAPI regenerated.
- **Web:** accept confirm `processing`; poll shows Waiting for Tazapay then paid; treasury field labelled **FlexiPay settlement account**.
- **Migration:** `20261107120000_ccr39_direct_solana_treasury` adds `Payment.solanaPayReference` and `Payment.solanaIntentAt`.

## CCR-40 (integrator, 7 Nov 2026): pay from any supported currency into any covered country

- **Why:** the founder wants FlexiPay to pay from any currency into any country, as far as partners reach. Dollars only reached US, PH, BR and ZA.
- **What:** a Tazapay sandbox sweep on 7 Nov quoted $100 from a USD balance to all 64 Tazapay local-rail countries, including GB (GBP). New corridors: US → every Tazapay country (USDC on Stellar, then the Tazapay pair), US → MX/AR (BlindPay and Tazapay compete), US → CO (BlindPay), GB → US (tGBP on Solana, Tazapay pays USD). US-BR and US-ZA now also list Tazapay, so three or two routes compete. 131 corridors in total.
- **Tazapay adapter:** GBP and USD are payout currencies as well as holding currencies (a USD balance pays GBP in the UK; a GBP balance pays USD in the US); only tGBP and USDC are never payouts. The health check uses the first local payout currency.
- **Placeholder rates:** USDC → XX and XX → USD from the sweep (validator and fee totals only; no simulated payout exists on the new corridors, so they never price a route); USDC → COP, TGBP → USD and USD → GBP likewise.
- **Router check (sandbox, $100):** MX BlindPay MX$1,818.00 beats Tazapay MX$1,655.14; BR BlindPay R$539.63 beats simulated R$534.37 and Tazapay R$467.62; KE KSh 11,570.80, FR €79.80, IN ₹8,475.60, CO COP 313,902 via their partners; £100 GB → US $121.65.
- **Tests:** adapters-live 41 (1 new), domain 99, API 171.

## CCR-41 (integrator, 7 Nov 2026): fixes from the API test audit (#183)

- **Idempotency race:** `withIdempotency` now claims the key first (a placeholder record, `responseStatus` 0, under the unique `(organizationId, key)` index), runs the handler, then stores the result. A concurrent request with the same key gets the stored result or **409 `idempotency_in_progress`** (retry shortly). Before: 4 parallel `POST /v1/payments` with one key created 3 payments. A handler error releases the claim so the key can be retried.
- **202 is never cached:** a "pending, retry with the same key" answer is not stored, so the retry reaches the final answer.
- **Unregistered provider:** a leg whose provider is not registered fails through `onProviderLegFailed` (CCR-14 retry, then refund) instead of being failed directly, which left a payout after settle stuck in `processing`.
- **Fund and cancel** take a strict empty body: unknown fields are 400 `validation_error`, like every other POST. `openapi.json` regenerated.
- **Open (dormant passkey feature):** after a passkey submit succeeds, a retry with the same key is refused (409 already accepted) before the cache lookup instead of replaying the stored 200.

## CCR-42 (integrator, 7 Nov 2026): security hardening

- **Rate limit:** every `/v1` route answers 429 `rate_limited` (with `Retry-After`) past 600 requests a minute per API key or session, or 300 a minute per client address on the public `/v1/claims/*` routes. Clients should back off and retry after `Retry-After` seconds.
- **Headers:** every API response carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, HSTS and `Referrer-Policy: no-referrer`. `/v1/*` responses are `Cache-Control: no-store`. No body or status changes.
- **Passkey submit (bug 4):** a retry with the same Idempotency-Key after a successful submit returns the stored 200 instead of 409 "already accepted". A new key on an accepted claim is still 409.
- Tracker: `docs/PLATFORM_TRACKER.md` section 4.

## CCR-43 (builder, 7 Nov 2026): recipient address for partner payouts

- **Problem:** Tazapay refuses Kenya bank payouts until `address.line1`, `address.city`, `address.state`, `address.postal_code` and a branch code are present. FlexiPay never collected a recipient address, and branch code stayed optional, so the failure happened after the sender had paid.
- **Recipient:** `POST /v1/recipients` accepts an optional `address` (`line1`, `line2?`, `city`, `state`, `postalCode`, `country`). `country` must equal the recipient country. The address is returned on create and list (`address: null` when unset). Migration `20261107190000_ccr43_recipient_address` adds nullable `Recipient.addressLine1`, `addressLine2`, `addressCity`, `addressState`, `addressPostalCode`.
- **Quote:** optional `payout.details` and `payout.address` on `POST /v1/quotes`. Routing asks the partner for `required_bank_fields`, `required_bank_codes` and `local_fields` (cached per country and currency) and excludes that partner, with a reason naming the missing fields, when they are not on the quote. The check runs only when the quote carries `payout` (the web Send form always does for bank payouts): a Kenya quote whose payout profile lacks the address or branch code is `422 not_eligible` instead of a payout failure after funding. A quote without `payout` (API clients, claim links where the recipient picks the bank later) keeps every partner; the payout leg still checks the real endpoint.
- **Tazapay:** the beneficiary body includes `address.line1`, `address.city`, `address.state`, `address.postal_code` (and `country`, `line2` when set) when the recipient has an address. `GET /v1/payout-requirements?country=&currency=` returns `detailKeys`, `localFields` and `addressRequired` for the Send form.
- **Web:** the Send form shows the address and marks Branch code required when that endpoint says the country needs them.
- **OpenAPI:** `apps/api/openapi.json` regenerated.

## CCR-44 (builder, 8 Nov 2026): live-mode readiness for individual senders

- **Network:** `FP_SOLANA_CLUSTER=mainnet-beta` starts only with `FP_LIVE_MONEY=1`. Without it the API throws before it listens. Mainnet USDC defaults to Circle's mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Devnet still defaults to the test mint. This replaces `FP_SOLANA_MAINNET_APPROVED` as the startup gate. Live mode also requires `FP_INDIVIDUAL_MAX_PAYMENT_USD`, `FP_INDIVIDUAL_MAX_24H_USD` and `FP_INDIVIDUAL_MAX_30D_USD`.
- **Kill switch:** in live mode, `FP_LIVE_PAYMENTS_ENABLED=0` makes `POST /v1/quotes` and `POST /v1/payments` answer **503 `live_payments_paused`**. Reads, cancel/refund and status polling keep working. The switch does nothing when the cluster is not `mainnet-beta`.
- **Limits:** those three amounts are USD (up to 2 decimal places) and apply per organization whose kind is `individual`. A quote or payment above the per-payment cap, or above the remaining rolling 24 hour or 30 day total, is **422 `limit_exceeded`**. `details.remaining` is USD cents still allowed: `payment`, `rolling24h`, `rolling30d`. `details.amount` is this payment in USD cents. Business organizations are not capped. Cancelled, failed, refunded and expired payments do not count. The send amount is converted with a direct config FX rate to USD; USD is already cents.
- **Web:** a banner says **Live money** or **Test mode**. On mainnet, simulated and sandbox partner labels and the sandbox coverage list are hidden. Before a mainnet signature, the payer confirms amount, fees, what the recipient gets, and the partner. Tests never call mainnet.
