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

## CCR-6: sandbox `advance-time` request body (proposed; identifier preserved, 22–23 Oct 2026)

- **From:** A0 / sandbox stubs (`packages/domain/src/api/sandbox.ts`, OpenAPI).
- **Status:** **proposed — not contracted.** Identifier **CCR-6 stays with advance-time** (do not reuse for simulation flags).
- **What:** accept an explicit request body for `POST /v1/sandbox/advance-time` (e.g. seconds or target clock) so N1/N3 expiry demos are typed. Until accepted, the route may exist as a stub without a success/request schema on main.
- **Why:** ARCHITECTURE §10 and SCENARIOS N1/N3 move the API clock for quote/claim expiry; ledger time is separate (CCR-5).
- **Who is affected:** A0, CC3 sandbox routes, D1 negative cases.
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
  - **`Leg.releaseTxRef`** — hash from `ReleaseResult.txRef` (or refund tx for cancel/refund path). Nullable until release/refund succeeds.
  - Provider legs keep `externalRef` as the provider reference string; `lockTxRef` / `releaseTxRef` stay null.
- **Acceptance scripts** may use public Horizon effects on `releaseTxRef` plus `externalRef` as payoutId; never require secrets.
- **Who implements:** CC2 writes the three fields; do not overwrite `externalRef` with a tx hash.

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
