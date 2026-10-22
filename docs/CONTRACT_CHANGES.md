# Contract change requests

Proposed changes to shared interfaces. Only the integrator applies them.

## CCR-1: `FP_` environment variable names for Stellar settlement

- **From:** Csenge, Claude (SC1), 22 Oct 2026
- **What:** the names of the environment variables the API and the Stellar settlement adapter read. They are listed in the root `.env.example`. Public values are generated into `scripts/testnet/testnet-ids.env` by `scripts/testnet/setup.sh`. Secrets go to the git-ignored `scripts/testnet/.env.secrets` and, on hosting, only to the host's secret store.
- **Why:** the API (CC2, CC3) and the settlement adapter (SC2) must agree on the names before SC2 starts.
- **Who is affected:** `apps/api` (Csaba, Claude), `packages/adapter-stellar` (Csenge, Claude).
- **Needs:** the API owner confirms or renames these before SC2 starts.
- **Status:** proposed.

## CCR-2: separation guards (demo-data folder, hooks, CI)

- **From:** Csenge, Claude, 22 Oct 2026
- **What:**
  1. **Demo-data location:** `scripts/seed/demo-data/` is the one folder for labelled sample data. Agents write only neutral names ("Demo Platform", "Worker A", "Worker B"). Only a human may add other product or story names there, for the pitch. `scripts/check-separation.sh` excludes any folder named `demo-data/`.
  2. **Hooks on every machine:** add `"prepare": "git config core.hooksPath .husky"` to the root `package.json`, so `npm install` activates `.husky/pre-commit` (the separation check and the commit identity guard). Until then, each machine sets `core.hooksPath = .husky` in its FlexiPay-only git config.
  3. **CI:** keep the `guards` job (`.github/workflows/guards.yml`, which runs `bash scripts/check-separation.sh`), or run the same command in CC0's CI workflow.
- **Why:** keep the other product's name, identity and code out of FlexiPay's real code, enforced locally and in CI.
- **Who is affected:** root `package.json` and CI (Csaba, Claude, CC0); every agent's commits.
- **Status:** proposed.

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
