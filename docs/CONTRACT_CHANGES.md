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

## CCR-20: public passkey claim API (M2) — **ACK'd** (944cabb)

- **From:** Csaba Cursor M2 plan (`event/csaba-cursor/m2-passkey`); EVENT_PLAN §4 E2.
- **Status:** **ACK'd** by Csaba (implementation base `944cabb`). Deploy route mounts on the event branch; prepare/submit follow on the same branch. Still **not** merged to `main` until the event gate.
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
5. **HTTP responses (ELFOGADÁSRA VÁR clarification):**
   - **`200` + `PasskeySubmitResponseSchema`:** only when RPC reports **SUCCESS** for the release and settle **`Leg.releaseTxRef`** is written. Body includes required `releaseTxRef` (= that leg field).
   - **`202` + `PasskeySubmitPendingResponseSchema`:** when the envelope is persisted and/or submitted but release is **not** yet confirmed (`PENDING`, waiting, or re-query after NOT_FOUND/timeout while still bound to the same `pendingTxHash`). Body: `{ status: "pending", prepareId, paymentId, paymentStatus, pendingTxHash }`. **No `releaseTxRef`.** Client must not treat 202 as paid/released; poll `GET /v1/claims/{token}` or retry submit with the same Idempotency-Key.
   - Never return **200** with a required `releaseTxRef` before the release is verified.
6. **Restart / lost HTTP:** if prepare `pendingTxHash` set → `getTransaction` first. SUCCESS → write/read `Leg.releaseTxRef` then **200**; PENDING → **202** (same pending hash); NOT_FOUND/timeout → restore sealed envelope for the **same** hash (not FAILED), respond **202** until SUCCESS or proven FAILED; proven FAILED → documented recovery only. Idempotent HTTP replay uses `IdempotencyRecord` after claim re-validation; cached body must match the outcome (200 vs 202) — never a foreign claim.

### Errors (stable codes)

`404 not_found`; `409 expired` | `invalid_state` | `settle_failed` | `prepare_expired` | `auth_expired` | `idempotency_conflict`; `422 invalid_deploy_tx` | `contract_mismatch` | `wasm_mismatch` | `constructor_mismatch` | `invalid_contract_id` | `auth_mismatch`; `502 deploy_failed` | `prepare_failed` | `release_failed`.

### Persistence

- `ClaimLink` passkey deploy columns + `PasskeyClaimPrepare` (migration `20261025112500_ccr20_passkey_prepare`).
- Apply migration only after CCR ACK (or local M2 disposable DB).
- No change to public `ClaimView` shape in this CCR.

### Acceptance (after ACK + implementation)

- Domain contract tests for the three request/response schemas and OpenAPI stubs.
- Testnet: deploy hash + `Leg.releaseTxRef`; vault Claimed to `C…`; evidence without secrets/tokens.
- Manual passkey ceremony on a real authenticator (virtual authenticator is not biometrics proof).
