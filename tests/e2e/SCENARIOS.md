# API acceptance scenarios — DF1 to DF5 (SF3-prep)

**Status:** written specification for automated tests. **No test has run**: there is no API
implementation or OpenAPI document yet, so nothing here is executed by this task.

**Sources (re-read 22 Oct 2026):** ARCHITECTURE **v4** §6.4 (Quote), §6.5 (Payment), §6.6
(Leg), §6.7 (Batch, ClaimLink), §6.8 (corridors), §7 (state machine and duplicate rules),
§8 (routing, retry, refund), §9 (events), §10 (API v1 and error codes), §11.2 (settlement
adapter), §12 (vault), §15 (DF1 to DF5); DEV_PLAN **v4** §4 (SF3) and §10; PRODUCT v3 §7;
`contracts/payout_vault/RULES.md` at `40c2e9d`; `docs/CONTRACT_CHANGES.md` at `40c2e9d`.
**CCR-3** (approved) is on `csenge-freebuff/SF0-config-draft` at `b985c8b`, not yet on
`main`; it confirms the corridor and crypto-destination decisions used below. The v4
documents live outside the repo (`../files/`); the repo root still holds v3.

**Revision after review (22 Oct 2026):** second conversion legs on fiat routes, claim-linked
`settle` state, non-interchangeable payout providers, BR-only vault refund, success codes
left TBD, and the scope of sandbox time. Each is marked where it applies.

## What is specified and what is not

- **Specified:** paths (§10), statuses (§7), leg kinds (§6.6), route shape and retry/refund
  rules (§8), event types (§9), error classes and the 409 rule (§10), vault external-id
  derivation, fee formula, `FeeMode` and error 12 (`RULES.md`).
- **Not specified:** every request and response **body shape**, and every **success status
  code**. §10 names only error classes (`400`, `401`, `404`, `409`, `422`); it never names a
  success code, so every success cell is `2xx (TBD — CC0 OpenAPI)`. Fields not named in
  §6.4–§6.7 or §10 are also **TBD (CC0 OpenAPI)** and must not be guessed.
- **Money:** integer minor-unit strings with an explicit currency, e.g. `"500000" USD`.
  Test USDC has 7 decimals: `1 USDC = 10000000` minor units (`RULES.md`).
- **Naming:** "Demo Platform" organization, "Worker A", "Worker B", "Worker C" recipients.
- **Corridor values** are the approved demo policies (SF0 draft, PR #1): PH payout providers
  `sim_bank_ph_instapay` (bank) and `sim_ewallet_ph` (e-wallet), BR `sim_bank_br_pix`, ZA
  `sim_bank_za_eft`, US domestic `sim_bank_us_ach`, FX `sim_fx`, rail `stellar_usdc`. They
  are **not on `main`** until the config lands.

## Common setup

1. `POST /v1/sandbox/reset` — reset and reseed.
2. Create three recipients and their endpoints: Worker A (PH `ewallet`), Worker B (BR
   `bank_account`), Worker C (US `bank_account`). Payloads **TBD (CC0 OpenAPI)**.
3. Authenticate as the Demo Platform organization (`Authorization: Bearer <api key>`); every
   `POST` also sends `Idempotency-Key`. Claim endpoints are public (§10).
4. A request that is not eligible returns `422` with reasons, never a silent fallback (§6.8).

## DF1 — one batch, three corridors

Rows: Worker A (PH e-wallet, `"25000" PHP` receive), Worker B (BR bank), Worker C (US
domestic bank). What a batch row carries is **TBD (CC0 OpenAPI)**.

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/batches` | rows for the three payments; `profile: batch` | 2xx (TBD) | batch created, `status` derived; three payment ids | — |
| 2 | `POST /v1/payments/{id}/fund` per payment (§10 specifies no batch fund path — **TBD**) | — | 2xx (TBD) | each payment `funded` → `processing` | `payment.funded` ×3 |
| 3 | `GET /v1/batches/{id}` | — | 2xx (TBD) | totals; each payment `paid` | `batch.completed` |
| 4 | `GET /v1/payments/{id}` for the US domestic payment | — | 2xx (TBD) | legs exactly `collect` + `payout`, both `sim_bank_us_ach`; **no `convert` and no `settle` leg**; `domesticRail: sim_bank_us_ach` | `leg.succeeded` ×2, `payment.onchain` **absent** |
| 5 | `GET /v1/payments/{id}` for the PH payment | — | 2xx (TBD) | `collect sim_bank_us_ach` → `convert sim_fx` → `settle stellar_usdc` → **`convert sim_fx`** → `payout sim_ewallet_ph` | includes `payment.onchain` |
| 6 | `GET /v1/payments/{id}` for the BR payment | — | 2xx (TBD) | same five leg kinds as PH, with `payout sim_bank_br_pix` | includes `payment.onchain` |

**Two conversion legs.** §8 builds the stablecoin route as `collect → convert → settle on
Stellar → convert → payout`, so a PH or BR fiat payment has **two `convert` legs**, both on
`sim_fx`: one before settlement (USD to USDC) and one after it (USDC to PHP or BRL). §6.8
holds the rail once per leg kind, so the corridor config has a single `convert: sim_fx`
entry; the payment timeline still has two convert legs. The domestic route has neither.

**Route explanation (DF1 acceptance).** The US domestic quote's `reasons` must be non-empty
and must name the domestic rail as the choice (cheapest or fastest among the domestic
candidates), not a generic "best route" string. Exact wording **TBD (CC0 OpenAPI)**.

## DF2 — one-off quote to paid

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | source endpoint, destination (PH `bank_account`, kind `individual`), amount with fixed side `send` | 2xx (TBD) | quote has `route`, `fees`, `fxRate`, `expectedReceive`, `validUntil` (~120 s, placeholder), `alternatives`, `reasons`, `simulated` | — |
| 2 | `POST /v1/payments` | `quoteId`, `recipientId`, `externalId`, `delivery: direct`, `profile: one_off` | 2xx (TBD) | `awaiting_funding`; no leg started | `payment.created` |
| 3 | `POST /v1/payments/{id}/fund` | — | 2xx (TBD) | `funded` then `processing`; legs `pending` → `processing` in order | `payment.funded`, `payment.processing` |
| 4 | `GET /v1/payments/{id}` until terminal | — | 2xx (TBD) | `paid`; **all five legs** `succeeded`; last leg is `payout`; route equals the quoted `route` | `leg.succeeded` per leg, `payment.onchain` at settle, `payment.paid` |

Assertions: a payment is `paid` only when its last leg succeeded (§7); a leg starts only
after the previous one succeeded, so the timeline is strictly ordered by `kind`.

## DF3 — claim link, crypto destination, testnet reference

Use PH or BR (both approve `crypto_wallet`). Below: PH individual.

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | destination PH `crypto_wallet`, kind `individual` | 2xx (TBD) | route ends at `settle`; **no `payout` leg planned** | — |
| 2 | `POST /v1/payments` | `delivery: claim_link`, `quoteId`, `recipientId` | 2xx (TBD) | `awaiting_funding`; claim link returned (raw token only in the link) | `payment.created`, `claim.opened` when opened |
| 3 | `POST /v1/payments/{id}/fund` | — | 2xx (TBD) | `processing`; `collect` and `convert` succeed; **`settle` stays `pending`** — with no `payout` leg, `settle` is the leg that waits (§7) | `payment.funded` |
| 4 | `GET /v1/claims/{token}` (public) | — | 2xx (TBD) | what is waiting: amount, corridor, allowed endpoint types | — |
| 5 | `POST /v1/claims/{token}/accept` | chosen `crypto_wallet` endpoint (address) | 2xx (TBD) | `settle` succeeds (vault release to the address) and the payment becomes `paid`; legs are `collect`, `convert`, `settle` only — **no `payout` leg**; a Stellar testnet transaction hash is visible (field **TBD**) | `claim.accepted`, `payment.onchain`, `payment.paid` |

Assertions: **no leg is `succeeded` and the payment is not `paid` before acceptance.** With
no payout leg, §7's "the payout leg waits in `pending` until the recipient accepts" applies
to `settle`, so the transaction hash appears only at claim time. The hash assertion requires
`StellarSettlementAdapter` (§11.2); with `MockSettlementAdapter` the network is `mock` and
the reference is simulated — record which adapter ran, and never label a real testnet hash as
simulated.

## DF4 — payout failure

**Payout providers are not interchangeable.** Each provider serves one endpoint type
(`sim_bank_ph_instapay` bank, `sim_ewallet_ph` e-wallet), so one cannot stand in for the
other. No baseline endpoint type has two eligible payout providers: PH has one bank and one
e-wallet, and BR, ZA and US have one each.

Setup: a funded BR payment — vault-settled (`stellar_usdc`) with the single payout provider
`sim_bank_br_pix`. **ZA cannot be used here:** its route has `settle: none`, so there is no
vault lock to refund.

| Branch | Control | Expected |
|---|---|---|
| **(a) retry succeeds** | `POST /v1/sandbox/fail-next` targeting `sim_bank_br_pix` | first payout attempt `failed`, retry once on the **same** provider `succeeded`; payment `paid`; two payout attempts in the timeline; **no vault refund and therefore no new lock attempt** |
| **(b) re-route after a failed retry** | would need a second eligible provider for the same endpoint type | **not producible** with the baseline providers — recorded as a gap below, not asserted |
| **(c) no alternative, refund** | `sim_bank_br_pix` failing with no alternative | vault refund and reversal of earlier legs; payout leg stays `failed`, collect leg `reversing` → `reversed`; payment `refunded`; events `leg.failed`, `payment.refunded` |

**Gaps that block the automated run** (recorded, not worked around — no provider, endpoint or
control is added by this task):

1. **`fail-next` fails one call.** It makes "the next call" to a provider fail (§10), so
   branch (b) cannot get two consecutive failures and (c) cannot get a persistent one.
   Re-invoking between attempts is racy. **Needed:** a count, or a per-provider `down` state
   the orchestrator observes *after* funding (`/v1/sandbox/provider-health` marks a provider
   down, but one already down at quote time is filtered out and yields no payment).
2. **No second payout provider.** Branch (b) needs another provider serving the *same*
   endpoint type. None exists, and adding one is SF1 work, not this task. Until then (b) is
   unexercisable and the other two do not prove re-route.
3. **Refund timing is on-chain, not sandbox time.** `RULES.md` refunds only when the ledger's
   `now >= expires_at`; before that only `cancel` (payer-authorised) returns the lock.
   `advance-time` moves the API's **quote and claim** expiry (§10), not ledger time, so it
   cannot make a vault refund observable. A refund test needs a short `expires_at` chosen at
   lock time, or CC2 must specify `cancel`. **This is a CC2 spec question, not a test knob.**
4. **Attempt timeline.** Two payout attempts on one leg must be visible; whether
   `GET /v1/payments/{id}` exposes attempts or only the latest state is **TBD (CC0 OpenAPI)**.

## DF5 — South Africa, company, crypto excluded

| # | Method and path | Specified request fields | HTTP | Payment / route | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | destination ZA `bank_account`, kind `company` | 2xx (TBD) | `collect sim_bank_us_ach` → `convert sim_fx` → `payout sim_bank_za_eft`; **no `settle` leg**; `reasons` list a crypto exclusion naming the recipient kind | — |
| 2 | `POST /v1/quotes` with destination ZA `crypto_wallet` | — | 422 | not eligible, reason naming the recipient kind | — |
| 3 | `POST /v1/payments` + `POST /v1/payments/{id}/fund` | from the eligible quote | 2xx (TBD) | `paid`; legs exactly `collect`, `convert`, `payout`; **no `settle` leg and no `payment.onchain`** | `leg.succeeded` ×3, `payment.paid`, no `payment.onchain` |

Assertion: the exclusion is explained, not silent; the reason must name the recipient kind
(§8 example: "Crypto leg not allowed for companies in this corridor"). Exact wording **TBD
(CC0 OpenAPI)**. A ZA payment has one conversion leg and no settlement, so no on-chain event.

## Negative cases

| Id | Steps | Expected |
|---|---|---|
| N1 | quote, `POST /v1/sandbox/advance-time` past `validUntil`, then `POST /v1/payments` with that `quoteId` | `422` not eligible with an expiry reason (**TBD**: 422 vs 409); **no payment is created**; the client must re-quote (§7) |
| N2 | two `POST /v1/payments` with the same `externalId` for one organization | first succeeds (`2xx`, TBD); second `409`; only one payment exists (§7, §10) |
| N3 | claim link, advance API time past `expiresAt`, then `POST /v1/claims/{token}/accept` | error (409 state conflict or 422 — **TBD**); claim `expired`, payment `expired`. **Vault refund caveat:** `advance-time` moves the API expiry only (§10); the vault refunds at its own `expires_at`, so "refund ran" is observable only if the lock's expiry has also passed — otherwise the case stops at `expired` |

## Identity and fee assertions

- **Client id is not the on-chain id.** The client `externalId` never goes on-chain
  (`RULES.md`). Every vault lock uses `external_id = sha256(utf8("<payment id>:<attempt>"))`,
  attempt starting at 1. Worked values: `pay_demo_1` attempt 1 hashes `pay_demo_1:1`,
  attempt 2 hashes `pay_demo_1:2`.
- Attempt 1 is used on first lock; a re-lock after a refund uses attempt 2; re-using attempt 1
  fails with **code 12, `DuplicateExternalId`** — name and number from `RULES.md` only.
- An external id stays used after `cancel` or `refund`; a new attempt is required.
- **A provider retry inside a lock does not re-lock** (DF4 branch a): same payout, same id.
- **Fee:** on a vault-settled route the FlexiPay fee is the contract's `config()` fee
  (`amount * fee_bps / 10000`, rounded down), never a configured percentage; assert the quoted
  fee equals the contract value at quote time. Outside-vault leg fees are the labelled
  placeholders in `providers.json`; assert attribution and the simulated label, not a price.
- **Fee side** is the payout's `FeeMode`: `PayerPays` locks amount + fee, `RecipientPays` pays
  amount − fee (`RULES.md`, confirmed by CCR-3), so DF3 asserts the claimed amount equals the
  quoted `net`, not the gross.
- **Not observable through the API** (do not invent fields; these are SF2/integration or
  contract coverage): `payout_by_external` recovery, duplicate-lock rejection, `balance`.

## Fixture requirements

No fixture file is committed: no request or response schema is known, so a fixture would be
an invented interface. Once CC0 OpenAPI lands the tests need three recipients with endpoints
(PH `ewallet`, BR `bank_account`, US `bank_account`) plus a PH `crypto_wallet` address for
DF3, one batch row set, one quote request per corridor, and the `fail-next` target for DF4.
Values are neutral; no secret, key or address is committed, and the DF3 hash is produced at
run time.

## Open questions and gaps

1. **CCR-3 is approved but not on `main`** (`b985c8b`). Its open item — whether "no payout
   for crypto destinations" lives in CC1 or becomes a CC0 corridor field — affects how DF1
   and DF3 build route assertions, not the expected outcomes. Merge it before CC1 starts.
2. **No CC0 OpenAPI**, so bodies, success codes, batch row shape, claim payload and the
   attempt timeline are **TBD**.
3. **DF4** is blocked on all four points above: control semantics, a second eligible
   provider, ledger-time refund, attempt exposure.
4. **Config is not merged** (PR #1), so DF1 and DF5 cannot run yet.
5. `tests/e2e` is the API flow location named in §15; the existing Playwright specs sit in
   `e2e/`, which §15 calls `tests/e2e-ui`. Moving them is CC0's restructure, not this task's.

<!-- written specification; no test has been executed by this task -->
