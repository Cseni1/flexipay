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
