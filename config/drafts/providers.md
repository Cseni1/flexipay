# Providers — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet. This is the reviewable
content for `config/providers.json`, written only after the CC0 configuration schema and
loader are merged. No adapter code is written in this task.

**Sources (re-read 22 Oct 2026):** ARCHITECTURE **v4** §3 (test USDC asset), §4 (folder
ownership), §6.3 (endpoint types), §6.6 (leg kinds and the `stellar_usdc` rail id), §8 (the
vault fee), §11.1 (provider capabilities and the six baseline providers), §11.2 (settlement
adapter), §12 (contracts, vault id), §14 (environment variables), §16 (defaults), §19 (v4
revision notes); DEV_PLAN **v4** §4 (SF1 simulated provider list); the SF0-prep task card;
the architect decisions of 22 Oct 2026.

**What each value is:** a value is **source-defined** (a cited section states it),
**approved simulated demo policy** (decided for this simulated build), or a **placeholder**
(a number, labelled `(placeholder)`, that is not a real provider quote). Every number here
is a placeholder — including zeros — and must be shown with the "Simulated" label, never as
a price. No real money moves and no secrets belong in config.

## Conventions used by these tables

- **Money** is an integer in minor units, in double quotes, followed by an explicit ISO
  currency: `"1500" PHP` means 1500 minor units (15.00 PHP). No floats, no decimals.
- **`feeBps` and `fxSpreadBps`** are integer basis points: 100 bps = 1.0 percent.
- **`estimatedTimeSeconds`** is an integer number of seconds.
- **`endpointTypes`** uses only ARCHITECTURE §6.3 values: `bank_account`, `ewallet`,
  `crypto_wallet`, `crypto_custodial`. `none` means the provider does not accept endpoints
  (it operates on a conversion leg).
- **`legKinds`** uses only §6.6 values: `collect`, `convert`, `settle`, `payout`.
- **`countries`** and **`currenciesOrAsset`** are comma-separated lists.
- **`none` in a limit column** means the provider imposes **no limit of its own**. It is not
  a zero limit and not an empty placeholder to be filled later.
- **`(placeholder)`** in a column header marks every value in that column as an unapproved
  draft placeholder.
- Provider `kind` values follow §11.1 (bank, e-wallet, FX). `anchor` is deliberately
  absent: the anchor is event work and out of scope for this task.

## Table P1 — simulated providers

Six simulated providers, exactly the §11.1 baseline list and the SF1 list in DEV_PLAN §4.
Each one must carry `simulated: true` in config and show the "Simulated" label in the UI.

| id | kind | countries | currenciesOrAsset | endpointTypes | legKinds | feeFixed (placeholder) | feeBps (placeholder) | fxSpreadBps (placeholder) | estimatedTimeSeconds (placeholder) | min (placeholder) | max (placeholder) | simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sim_bank_us_ach | bank | US | USD | bank_account | collect, payout | "0" USD | 0 | 0 | 60 | "100" USD | "5000000" USD | true |
| sim_bank_ph_instapay | bank | PH | PHP | bank_account | payout | "1500" PHP | 50 | 0 | 120 | "5000" PHP | "5000000" PHP | true |
| sim_ewallet_ph | ewallet | PH | PHP | ewallet | payout | "1000" PHP | 100 | 0 | 30 | "1000" PHP | "1000000" PHP | true |
| sim_bank_br_pix | bank | BR | BRL | bank_account | payout | "200" BRL | 0 | 0 | 30 | "500" BRL | "2000000" BRL | true |
| sim_bank_za_eft | bank | ZA | ZAR | bank_account | payout | "500" ZAR | 80 | 0 | 1800 | "10000" ZAR | "5000000" ZAR | true |
| sim_fx | fx | US, PH, BR, ZA | USD, PHP, BRL, ZAR | none | convert | "0" USD | 25 | 50 | 5 | none | none | true |

Notes on the six:

- `sim_bank_us_ach` serves the `collect` leg of a cross-border payment and is both the US
  domestic collect and payout rail (see `corridors.md`).
- `sim_bank_za_eft` is the only South Africa provider: a bank payout with no crypto leg.
- **`sim_fx` has no limit of its own.** Its `min` and `max` are `none`, recorded as an
  absence rather than as zero limits: the corridor's send-side limit is what applies (see
  `corridors.md`), and inventing a conversion-provider limit would decide a question no
  source answers. Its fixed fee is `"0" USD`, a labelled placeholder.
- For the single-currency fiat providers the amount currency is unambiguous (the provider's
  own payout currency), so their min, max and fixed fee keep placeholder values in that
  currency. They are never converted into the corridor's send currency.
- Fee and spread columns are independent: `feeFixed` is a flat per-leg charge, `feeBps` is a
  proportional charge on the leg amount, `fxSpreadBps` is the conversion margin. How the
  three combine into a leg quote is CC0/CC1 interface work, not decided here.
- These are the only configurable fee values for **outside-vault** legs, and they are
  recorded once, here. `fees.md` does not restate them.

## Table P2 — settlement rail (not simulated)

This row is the Stellar testnet settlement rail. It is a **real testnet** component, not a
simulated provider: it is listed separately, carries `simulated: false`, and must not be
shown with the "Simulated" label. It is the rail id used by the `settle` leg (§6.6).

| id | kind | network | asset | legKinds | simulated | metadata |
|---|---|---|---|---|---|---|
| stellar_usdc | settlement_rail | stellar | USDC test asset issued by our own issuer | settle | false | not config: comes from deployment settings (see below) |

Notes on the settlement rail:

- **Config holds only the rail id** `stellar_usdc`. It does not hold the asset issuer
  account, the asset precision, the network passphrase, the vault contract id or the vault
  fee.
- **Deployment metadata comes from approved `FP_` environment variables** (§14), and the
  deployed vault id is published in `scripts/testnet/testnet-ids.env` (§12, §19) and must
  never be hard-coded. The variable names are confirmed through the contract-change record
  (§14) and listed in the root `.env.example`; none is invented, and none is written here.
- **The vault fee is read from the contract's `config()`** at quote time — fixed at
  deployment, owner-specified at 1 percent. It is not a config value and not a configured
  FlexiPay percentage, so nothing in these drafts duplicates it (§8, §16).
- ARCHITECTURE §3 fixes the chain as Stellar testnet with a test USDC asset issued by our
  own issuer. The asset code is `USDC`.
- It has no fee, spread, time or limit columns on purpose, and it is never a `payout`
  provider: it is a settlement rail, not a provider adapter, so it has no countries or
  endpoint types.

## Boundary notes

- **No anchor provider.** The anchor, its SEP flows and any anchor rail id are event work,
  excluded from this task and from the baseline config.
- **No additional providers.** Only the six simulated providers above exist, plus the
  settlement rail. More eligible providers can be added later because every corridor leg
  maps to a list, but none is invented here.
- **No IDs reused elsewhere.** Provider ids are FlexiPay-specific and neutral; no other
  product's identifiers, accounts or sample data appear in this file.

## Open questions

None in this file. The conversion-provider limit and fee question is answered by the
architect decision (no own limit; `"0" USD` fixed fee placeholder), and the settlement
metadata question is answered by §12/§14/§19 (deployment settings and the published testnet
ids file, never config and never hard-coded).

<!-- draft only; not loaded by code and not a shared interface -->
