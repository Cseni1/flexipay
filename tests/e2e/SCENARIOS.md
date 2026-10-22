# API acceptance scenarios — DF1 to DF5 (SF3-prep)

**Status:** written specification for automated tests. **No test has run**: there is no API
implementation or OpenAPI document yet, so nothing here is executed by this task.

**Sources (read 22 Oct 2026):** ARCHITECTURE **v4** §6.4 (Quote), §6.5 (Payment), §6.6
(Leg), §6.7 (Batch, ClaimLink), §6.8 (corridors), §7 (state machine and duplicate rules),
§8 (routing, retry, refund), §9 (events), §10 (API v1 and error codes), §11.2 (settlement
adapter), §12 (vault), §15 (DF1 to DF5); DEV_PLAN **v4** §4 (SF3) and §10; PRODUCT v3 §7;
`contracts/payout_vault/RULES.md` at `40c2e9d`; `docs/CONTRACT_CHANGES.md` at `40c2e9d`.
The v4 documents live outside the repo (`../files/`); the repo root still holds v3.

## What is specified and what is not

- **Specified:** paths (ARCHITECTURE §10), payment and leg statuses (§7), leg kinds (§6.6),
  route shape and retry/refund rules (§8), event types (§9), error classes and the 409
  duplicate rule (§10), vault external-id derivation, fee formula and error 12
  (`RULES.md`).
- **Not specified:** every request and response **body shape**. No CC0 OpenAPI exists on
  `origin/main` (`config/` is absent; `api/` holds only the scaffold `health.js` and
  `pay.js`). Every field not named in §6.4–§6.7 or §10 is written **TBD (CC0 OpenAPI)** and
  must not be guessed. `TBD` is never a placeholder to fill with a convenient value.
- **Conventions:** success is `200` for reads and actions, `201` for creates unless CC0's
  OpenAPI says otherwise; error bodies are `{code, message}` and the error classes are
  `400`, `401`, `404`, `409` (idempotency, duplicate, state conflict), `422` (not eligible,
  with reasons). The exact code inside each class is **TBD (CC0 OpenAPI)**.
- **Money:** integer minor-unit strings with an explicit currency, e.g. `"500000" USD`.
  Test USDC has 7 decimals: `1 USDC = 10000000` minor units (`RULES.md`).
- **Naming:** "Demo Platform" organization, "Worker A", "Worker B", "Worker C" recipients.
  Sample data is neutral; no borrowed story names.
- **Corridor values** referenced below are the approved demo policies (SF0 draft, PR #1):
  PH payout providers `sim_bank_ph_instapay` and `sim_ewallet_ph`, BR `sim_bank_br_pix`,
  ZA `sim_bank_za_eft`, US domestic `sim_bank_us_ach`, FX `sim_fx`, settlement
  `stellar_usdc`. They are **not on `main`** until the config lands.

## Common setup

1. `POST /v1/sandbox/reset` — reset and reseed; 200.
2. Create three recipients and their endpoints: Worker A (PH `ewallet`), Worker B (BR
   `bank_account`), Worker C (US `bank_account`). Endpoint payloads **TBD (CC0 OpenAPI)**.
3. Authenticate as the Demo Platform organization: `Authorization: Bearer <api key>`; every
   `POST` also sends `Idempotency-Key`. Claim endpoints are public (§10).
4. A corridor only routes to an endpoint type it allows (§6.8); a request that is not
   eligible returns `422` with reasons, never a silent fallback.

## DF1 — one batch, three corridors

Batch rows: Worker A (PH e-wallet, `"25000" PHP` receive), Worker B (BR bank), Worker C (US
domestic bank). Batch rows carry the recipient, the amount and either a quote id or enough
detail for the server to quote per row — **TBD (CC0 OpenAPI)**.

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/batches` | rows for the three payments; `profile: batch` on each | 201 | batch created, `status` derived; three payment ids | — |
| 2 | `POST /v1/payments/{id}/fund` per payment (§10 specifies no batch fund path — **TBD**) | — | 200 | each payment `funded` → `processing` | `payment.funded` ×3 |
| 3 | `GET /v1/batches/{id}` | — | 200 | totals; each payment `paid` | `batch.completed` |
| 4 | `GET /v1/payments/{id}` for the US domestic payment | — | 200 | legs exactly `collect` + `payout`, both `sim_bank_us_ach`; **no `convert` leg and no `settle` leg**; `domesticRail: sim_bank_us_ach` | `leg.succeeded` ×2, `payment.onchain` **absent** |
| 5 | `GET /v1/payments/{id}` for the PH payment | — | 200 | `collect sim_bank_us_ach` → `convert sim_fx` → `settle stellar_usdc` → `payout sim_ewallet_ph` | includes `payment.onchain` |
| 6 | `GET /v1/payments/{id}` for the BR payment | — | 200 | `payout sim_bank_br_pix`; same four leg kinds as PH | includes `payment.onchain` |

**Route explanation (DF1 acceptance).** The US domestic quote's `reasons` must be non-empty
and must name the domestic rail as the choice (cheapest or fastest among the domestic
candidates). Assert that the reason mentions the rail or the absence of a conversion, not a
generic "best route" string. Exact wording **TBD (CC0 OpenAPI)**.

## DF2 — one-off quote to paid

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | source endpoint, destination (PH `bank_account`, recipient kind `individual`), amount with fixed side `send` | 200 | quote has `route`, `fees`, `fxRate`, `expectedReceive`, `validUntil` (~120 s, placeholder), `alternatives`, `reasons`, `simulated` | — |
| 2 | `POST /v1/payments` | `quoteId`, `recipientId`, `externalId`, `delivery: direct`, `profile: one_off` | 201 | `status: awaiting_funding`; no leg started | `payment.created` |
| 3 | `POST /v1/payments/{id}/fund` | — | 200 | `funded` then `processing`; legs `pending` → `processing` in order | `payment.funded`, `payment.processing` |
| 4 | `GET /v1/payments/{id}` until terminal | — | 200 | `paid`; every leg `succeeded`; last leg is `payout`; route equals the quoted `route` | `leg.succeeded` per leg, `payment.onchain` at settle, `payment.paid` |

Assertions: a payment is `paid` only when its last leg succeeded (§7); a leg starts only
after the previous one succeeded, so the timeline is strictly ordered by `kind`.

## DF3 — claim link, crypto destination, testnet reference

Use PH or BR (both approve `crypto_wallet`). Below: PH individual.

| # | Method and path | Specified request fields | HTTP | Payment / legs | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | destination PH `crypto_wallet`, recipient kind `individual` | 200 | route ends at `settle`; **no `payout` leg planned** | — |
| 2 | `POST /v1/payments` | `delivery: claim_link`, `quoteId`, `recipientId` | 201 | `awaiting_funding`; claim link returned (raw token only in the link) | `payment.created`, `claim.opened` when opened |
| 3 | `POST /v1/payments/{id}/fund` | — | 200 | `processing`; `collect`, `convert`, `settle` succeed; **no `payout` leg**; the vault lock waits for the claim | `payment.funded` |
| 4 | `GET /v1/claims/{token}` (public) | — | 200 | what is waiting: amount, corridor, allowed endpoint types | — |
| 5 | `POST /v1/claims/{token}/accept` | chosen `crypto_wallet` endpoint (address) | 200 | `paid`; legs are `collect`, `convert`, `settle` only — **no `payout` leg**; the payment exposes a Stellar testnet transaction hash for the vault release to the address (field name **TBD**) | `claim.accepted`, `payment.onchain`, `payment.paid` |

Assertions: the crypto destination ends at `settle` where the vault releases to the address
(no payout); the transaction hash is visible on the payment and resolves on Stellar testnet.
**The hash assertion requires `StellarSettlementAdapter`** (§11.2); with
`MockSettlementAdapter` the network is `mock` and the reference is simulated — record which
adapter the run used, and never label a real testnet hash as simulated.

## DF4 — payout failure, three branches

Setup for each branch: a funded payment whose route has a payout leg. Branch (a) and (b) use
PH (two payout providers: `sim_bank_ph_instapay`, `sim_ewallet_ph`); branch (c) uses BR or ZA
(one payout provider, so no alternative exists).

| Branch | Control | Expected |
|---|---|---|
| **(a) retry succeeds** | `POST /v1/sandbox/fail-next` targeting the payout provider | first payout attempt `failed`, retry once on the **same** provider `succeeded`; payment `paid`; timeline shows two payout attempts; **no vault refund and therefore no new lock attempt** (a provider retry is not a re-lock) |
| **(b) retry fails, re-route** | two consecutive failures on the same provider | after the second failure the next eligible payout provider from the routing alternatives is selected (`sim_ewallet_ph`); payment `paid`; events `leg.failed` for the first provider and `leg.succeeded` for the second |
| **(c) no alternative, refund** | BR or ZA payout provider failing with no other eligible payout provider | refund through the settlement adapter (vault refund) and reverse earlier legs; payout leg stays `failed`, collect leg `reversing` → `reversed`; payment `refunded`; events `leg.failed`, `payment.refunded` |

**Gaps that block a deterministic automated DF4** (recorded, not worked around — no provider,
endpoint or sandbox control is added by this task):

1. `POST /v1/sandbox/fail-next` makes **the next call** to a provider fail, a single failure
   (§10). Branch (b) needs two consecutive failures on the same provider, and branch (c)
   needs the failure to persist. Re-invoking the control between attempts is racy and cannot
   be asserted reliably; there is no count or "fail for this leg" parameter in the spec.
   **Needed:** `fail-next` accepting a count, or a per-provider `down` state that the
   orchestrator observes *after* funding (`/v1/sandbox/provider-health` marks a provider
   down, but a provider already down at quote time is filtered out and yields no payment).
2. **Refund before expiry.** `RULES.md` allows `refund` only at or after `expires_at`; before
   that only `cancel` (payer-authorised) returns the lock. A payout failure seconds after
   funding therefore cannot be refunded on-chain without advancing time. The scenario must
   call `POST /v1/sandbox/advance-time` past the claim expiry before asserting the refund, or
   the orchestrator must be specified to use `cancel`. **This is a spec question for CC2, not
   a test detail.**
3. Per-leg **attempt timeline** (two payout attempts on one leg) is required by the DF4
   acceptance; whether `GET /v1/payments/{id}` exposes attempts or only the latest leg state
   is **TBD (CC0 OpenAPI)**.

## DF5 — South Africa, company, crypto excluded

| # | Method and path | Specified request fields | HTTP | Payment / route | Events |
|---|---|---|---|---|---|
| 1 | `POST /v1/quotes` | destination ZA `bank_account`, recipient kind `company` | 200 | route `collect sim_bank_us_ach` → `convert sim_fx` → `payout sim_bank_za_eft`; **no `settle` leg**; `reasons` list a crypto exclusion naming the recipient kind | — |
| 2 | `POST /v1/quotes` with destination ZA `crypto_wallet` | — | 422 | not eligible, with a reason naming the recipient kind | — |
| 3 | `POST /v1/payments` + `POST /v1/payments/{id}/fund` | from the eligible quote | 201 / 200 | `paid`; legs exactly `collect`, `convert`, `payout`; **no `settle` leg and no `payment.onchain` event** | `leg.succeeded` ×3, `payment.paid`, no `payment.onchain` |

Assertion: the exclusion is explained, not silent. The reason must name the recipient kind
(§8 example: "Crypto leg not allowed for companies in this corridor"); exact wording **TBD
(CC0 OpenAPI)**. The ZA route has no settlement leg, so no on-chain event exists for it.

## Negative cases

| Id | Steps | Expected |
|---|---|---|
| N1 | quote, `POST /v1/sandbox/advance-time` past `validUntil`, then `POST /v1/payments` with that `quoteId` | `422` not eligible with an expiry reason (**TBD**: 422 vs 409, CC0 OpenAPI); **no payment is created**; the client must re-quote (§7) |
| N2 | two `POST /v1/payments` with the same `externalId` for the same organization | first 201; second `409`; only one payment exists (§7, §10) |
| N3 | claim link, advance past `expiresAt`, `POST /v1/claims/{token}/accept` | error (409 state conflict or 422 — **TBD**); claim `expired`, payment `expired`, vault refund ran (§7) |

## Identity and fee assertions

- **Client id is not the on-chain id.** The client `externalId` never goes on-chain
  (`RULES.md`). Every vault lock uses a 32-byte id:
  `external_id = sha256(utf8("<payment id>:<attempt>"))`, attempt a decimal number starting
  at 1. Worked values: payment `pay_demo_1` attempt 1 hashes `pay_demo_1:1`, attempt 2
  hashes `pay_demo_1:2`.
- Assertions: attempt 1 is used on first lock; a re-lock after a refund uses attempt 2 and
  succeeds; re-using attempt 1 fails with **code 12, `DuplicateExternalId`** — name and
  number from `RULES.md`, nowhere else.
- An external id stays used after `cancel` or `refund`; a new attempt is required.
- **A provider retry inside a lock does not re-lock.** Branch (a) of DF4 reuses the same
  payout and the same external id. Only a refund followed by a re-route or retry locks again.
- **Fee:** on a vault-settled route the FlexiPay fee is the contract's `config()` fee
  (`fee = amount * fee_bps / 10000`, rounded down), not a configured percentage; assert the
  quoted fee equals the contract value at quote time. Fees for legs outside the vault are
  the labelled placeholders in `providers.json`; assert attribution and the simulated label,
  not a fixed price.
- **Not observable through the API** (do not invent response fields for them — they are
  SF2/integration or contract coverage): `payout_by_external` recovery after a lost
  transaction response, duplicate-lock rejection at the contract, `balance(payer)`, and the
  vault events themselves.

## Fixture requirements

No fixture file is committed: no request or response schema is known, so a fixture would be
an invented interface. Once CC0 OpenAPI lands, the tests need: three recipients with
endpoints (PH `ewallet`, BR `bank_account`, US `bank_account`) plus a PH `crypto_wallet`
address for DF3; one batch row set (DF1) and one quote request per corridor; a claim-accept
payload naming the crypto endpoint; and the `fail-next` provider targets for DF4. Values are
neutral, money is integer minor-unit strings, and no secret, key or address is committed —
DF3 asserts the testnet hash produced at run time, never a stored one.

## Open questions and gaps

1. **CCR-3 is absent.** `docs/CONTRACT_CHANGES.md` on `origin/main` contains only CCR-1 and
   CCR-2, both `proposed`; there is no CCR-3. Details that were expected from it (crypto
   destination route shape, any API field it changes) are **not** asserted here beyond
   what §7/§8 already state. The integrator must land CCR-3 before these scenarios are
   treated as final.
2. **No CC0 OpenAPI.** Request/response bodies, batch row shape, claim acceptance payload,
   the batch fund action and the leg-attempt timeline are all **TBD (CC0 OpenAPI)**.
3. **DF4 controls** — see the two gaps above (consecutive failures, refund before expiry).
4. **Config is not merged.** The corridor and provider ids above come from the SF0 draft
   (PR #1). Until it lands, DF1 and DF5 cannot run.
5. `tests/e2e` is the API flow location named in §15; the repo's existing Playwright specs
   sit in `e2e/`, which §15 calls `tests/e2e-ui`. The move is CC0's restructure, not this
   task's.

<!-- written specification; no test has been executed by this task -->
