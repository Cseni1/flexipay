# Providers — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet. This is the reviewable
content for `config/providers.json`, written only after the CC0 configuration schema and
loader are merged. No adapter code is written in this task.

**Sources (re-read 22 Oct 2026, current copies):** ARCHITECTURE v3 §3 (test USDC asset),
§4 (folder ownership), §6.3 (endpoint types), §6.6 (leg kinds and the `stellar_usdc` rail
id), §11.1 (provider capabilities and the six baseline providers), §11.2 (settlement
adapter), §16 (defaults); DEV_PLAN v3 §4 (SF1 simulated provider list); the SF0-prep task
card.

**Confirmed vs unresolved:** a value is only written where a source states it. Space a
source leaves open is written `TBD` and listed in the blockers section; it is not an
approved value. Every number that is present is a **draft placeholder** — including zeros.
Fees, spreads and times are illustrative only, never a real provider quote, and never an
approved business limit. They must never be shown to a user as a price without the
"Simulated" label. No real money moves and no secrets belong in config.

## Conventions used by these tables

- **`TBD`** means unresolved: blocked on an integrator answer, never a guess.
- **Money** is an integer in minor units, in double quotes, followed by an explicit ISO
  currency: `"1500" PHP` means 1500 minor units (15.00 PHP). No floats, no decimals.
- **`feeBps` and `fxSpreadBps`** are integer basis points: 100 bps = 1.0 percent. No
  fractional bps and no percentages stored as floats.
- **`estimatedTimeSeconds`** is an integer number of seconds.
- **`endpointTypes`** uses only ARCHITECTURE §6.3 values: `bank_account`, `ewallet`,
  `crypto_wallet`, `crypto_custodial`. `none` means the provider does not accept
  endpoints (it operates on a conversion leg).
- **`legKinds`** uses only §6.6 values: `collect`, `convert`, `settle`, `payout`.
- **`countries`** and **`currenciesOrAsset`** are comma-separated lists so one provider
  can serve more than one country or currency.
- **`(placeholder)`** in a column header marks every value in that column as an
  unapproved draft placeholder.
- Provider `kind` values follow §11.1 (bank, e-wallet, FX). `anchor` is deliberately
  absent: the anchor is event work and is out of scope for this task.

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
| sim_fx | fx | US, PH, BR, ZA | USD, PHP, BRL, ZAR | none | convert | TBD | 25 | 50 | 5 | TBD | TBD | true |

Notes on the six:

- `sim_bank_us_ach` serves the `collect` leg of a cross-border payment and is the US
  domestic payout rail.
- `sim_bank_za_eft` is the only South Africa provider. It is a bank payout with no crypto
  leg; see the South Africa section in `corridors.md`.
- **`sim_fx` is a conversion provider with no single currency of its own.** Its minimum,
  maximum and fixed-fee currency all depend on which side a limit applies to, which §11.1
  does not state, so those three cells are `TBD` (Q6). Its integer bps and time columns
  are dimensionless and stay as placeholders.
- For the single-currency fiat providers the amount currency is unambiguous (the
  provider's own payout currency), so their min, max and fixed fee keep placeholder
  values.
- Fee and spread columns are independent: `feeFixed` is a flat per-leg charge,
  `feeBps` is a proportional charge on the leg amount, `fxSpreadBps` is the conversion
  margin. How the three combine into a leg quote is CC0/CC1 interface work, not decided
  here.

## Table P2 — settlement rail (not simulated)

This row is the Stellar testnet settlement rail. It is a **real testnet** component, not a
simulated provider: it is listed separately, carries `simulated: false`, and must not be
shown with the "Simulated" label. It is the rail id used by the `settle` leg
(ARCHITECTURE §6.6).

| id | kind | network | asset | legKinds | simulated | metadataStatus |
|---|---|---|---|---|---|---|
| stellar_usdc | settlement_rail | stellar | USDC test asset issued by our own issuer | settle | false | issuer account, asset precision, vault contract id and network passphrase are NOT specified in the sources; recorded as open question Q7, not invented here |

Notes on the settlement rail:

- ARCHITECTURE §3 fixes the chain as Stellar testnet with a test USDC asset issued by our
  own issuer. The asset code is `USDC`; the issuer account id, the asset precision and the
  `payout_vault` contract id are not in the sources read for this task.
- It has no fee, spread, time or limit columns on purpose: settlement network fees,
  confirmation times and the vault's fixed fee (read from the contract `config()`, per §8)
  are not specified in the sources, and inventing them would put a made-up number in
  config. Open question Q7.
- It is a settlement rail, not a provider adapter, so it has no countries or endpoint
  types, and it is never a `payout` provider.

## Blockers — unresolved cells (not approved configuration)

| cells | why unresolved | question | decided by |
|---|---|---|---|
| sim_fx feeFixed, min and max | a conversion provider serves several currencies; §11.1 does not state which side a limit or fee applies to | Q6 | integrator |

## Boundary notes

- **No anchor provider.** The anchor, its SEP flows and any anchor rail id are event work
  and are excluded from this task and from the baseline config.
- **No additional providers.** Only the six simulated providers above exist. More eligible
  providers can be added later because every corridor leg maps to a list, but none is
  invented here.
- **No IDs reused elsewhere.** Provider ids are FlexiPay-specific and neutral; no other
  product's identifiers, accounts or sample data appear in this file.

## Open questions (for the integrator; `docs/CONTRACT_CHANGES.md` is not edited here)

- **Q6 — limit side and fee currency for a conversion provider.** Affected: corridor
  loader, routing eligibility, provider `capabilities` (§11.1), FX quoting.
- **Q7 — settlement rail metadata.** Asset issuer account, asset precision, network
  passphrase and the `payout_vault` contract id are missing from the sources. Affected:
  settlement adapter (SC2), `docs/STELLAR.md`, seed and demo reset scripts. They must come
  from the testnet setup task, not be invented in config.
