# Corridors — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet. These tables are the
reviewable content for `config/corridors.json`, which is written only after the CC0
configuration schema and loader are merged. This file defines no shared interface and
no runtime behaviour.

**Sources:** ARCHITECTURE v3 §6.3 (endpoint types), §6.8 (corridor fields), §8 (routing
eligibility and optimisation), §16 (defaults); DEV_PLAN v3 §4 (trimmed SF0 scope);
PRODUCT v3 §6 (markets) and §7 (regulation-aware routing); the SF0-prep task card.

**Placeholders:** every number in this file is a **draft placeholder** — including zeros.
None of them is a real provider quote, an approved business limit or product policy.
Every corridor is simulated demo data (`simulated: true`).

## Conventions used by these tables

- **Money** is an integer in minor units, in double quotes, followed by an explicit ISO
  currency: `"100" USD` means 100 minor units (1.00 USD). No floats, no decimal points,
  no arithmetic on floating-point values anywhere in the future loader path.
- **`limits.*`** are per payment, in the corridor's `to` (receive-side) currency. The
  sources do not say which side a limit applies to; see open question Q3.
- **`legsAvailable`** maps the source-defined leg kinds (`collect`, `convert`, `settle`,
  `payout`, ARCHITECTURE §6.6) to comma-separated **lists** of provider or rail ids, so
  more eligible providers can be added later without changing the format. `none` means
  the corridor has no provider for that leg kind.
- **`domesticRail`** is `none` when `from` and `to` are different countries (§6.8).
- **`(placeholder)`** in a column header marks every value in that column as an
  unapproved draft placeholder.
- Recipient kinds are exactly `individual` and `company` (§6.2). Endpoint types are
  exactly `bank_account`, `ewallet`, `crypto_wallet`, `crypto_custodial` (§6.3).

## Table C1 — corridors

| from | to | allowedDestinationTypes | recipientKinds | cryptoLegAllowed.individual | cryptoLegAllowed.company | limits.individual.min (placeholder) | limits.individual.max (placeholder) | limits.company.min (placeholder) | limits.company.max (placeholder) | legsAvailable | domesticRail | regulationNote | simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| US USD | US USD | bank_account | individual, company | false | false | "100" USD | "2500000" USD | "100" USD | "5000000" USD | collect: none; convert: none; settle: none; payout: sim_bank_us_ach | sim_bank_us_ach | Domestic USD, same country and currency. Bank account only; no crypto route in this corridor. | true |
| US USD | PH PHP | bank_account, ewallet | individual, company | true | true | "5000" PHP | "5000000" PHP | "10000" PHP | "50000000" PHP | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_ph_instapay, sim_ewallet_ph | none | Cross-border USD to PHP. Bank account and e-wallet destinations; simulated rails only. | true |
| US USD | BR BRL | bank_account | individual, company | true | true | "1000" BRL | "1000000" BRL | "1000" BRL | "20000000" BRL | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_br_pix | none | Cross-border USD to BRL. Bank account only. The Latin American demo country decision is recorded in one section below. | true |
| US USD | ZA ZAR | bank_account | individual, company | false | false | "10000" ZAR | "2000000" ZAR | "10000" ZAR | "10000000" ZAR | collect: sim_bank_us_ach; convert: sim_fx; settle: none; payout: sim_bank_za_eft | none | Bank rails only. Draft cross-border crypto rules of 3 Aug 2026 are being rewritten with no timeline; demo policy, not legal advice. | true |

Exactly four corridors, as scoped by the task card: US to US, US to PH, US to BR and
US to ZA. ARCHITECTURE §6.8 also lists EU to EU, UK to UK, EU to PH, EU to BR, EU to MX
and US/EU to MX as demo corridors; those are out of scope for this card and are **not**
written here. No EU, UK or Mexico corridor and no Mexico provider exists in this task.

## Latin American demo country decision — single place

This subsection is the **only** place that records the Latin American demo country.

- **Default now:** Brazil. It is wired as the `US USD` to `BR BRL` row above and as the
  payout provider `sim_bank_br_pix` in `providers.md`.
- **Possible replacement:** Mexico, if the owner decision (due Friday 10:00 per
  DEV_PLAN §4) goes that way. No Mexico row or provider is created in this task.
- **Swap, when owner-approved:** replace the `US USD` to `BR BRL` row with the Mexico
  equivalent and replace the payout provider id with a Mexican bank rail that does not
  exist yet. The leg mapping, `regulationNote` pattern and limit conventions stay the
  same; `providers.md` gains the new provider row. No other change should be needed.
- **Who may change it:** only the integrator applies the swap, after the decision.

## Crypto eligibility, per corridor and recipient kind

Eligibility is per recipient kind (§6.8), which is why the table has one column per kind.

- **US to US — `false` for both kinds.** Same-country USD movement needs no crypto leg;
  the domestic rail is used.
- **US to PH — `true` for both kinds.** No source restricts this corridor, so the
  stablecoin route of §8 (collect, convert, settle on Stellar, convert, payout) is a
  candidate that competes with the fiat rails.
- **US to BR — `true` for both kinds.** Same reasoning.
- **US to ZA — `false` for both kinds.** See the South Africa section below.

Only South Africa is restricted by a source rule. The two `true` values for PH and BR are
the draft default for corridors with no restriction; a per-kind restriction there would
be a policy decision that changes this table only (open question Q4).

## South Africa — supplied demo policy

- `cryptoLegAllowed` is `false` for `individual` and for `company`.
- The corridor allows `bank_account` only: no `crypto_wallet` and no `crypto_custodial`
  destination endpoint type.
- `legsAvailable` contains **no** `settle` provider and never references `stellar_usdc`.
  The route is a bank payout with no crypto leg.
- Draft cross-border crypto rules of 3 Aug 2026 would stop companies sending or
  receiving crypto across the border; on 21 Oct 2026 the finance minister said they will
  be rewritten, with no timeline. Until final rules exist, this build routes South Africa
  over bank rails only.
- This is the **supplied demo policy for a simulated corridor**. It is not verified
  current law and not legal advice. It needs local counsel before it is treated as a real
  market rule.
- Demo flow expectation (DF5): a South Africa payment to a company excludes the crypto
  route with a reason naming the recipient kind, and chooses the bank route.

## Leg mapping, as drafted

- **Cross-border crypto route (§8):** `collect` on `sim_bank_us_ach`, `convert` on
  `sim_fx`, `settle` on `stellar_usdc`, `payout` on the corridor's payout providers.
- **Domestic route (§8: "the domestic rail"):** one leg on `sim_bank_us_ach`, recorded
  as `payout`, with `collect`, `convert` and `settle` set to `none`. §8 does not name the
  leg kind used for the domestic rail; this draft assumes `payout` (contract change
  request CC-2).
- **Bank-only cross-border route (ZA):** `collect`, `convert`, `payout`, with no
  `settle` leg. §8 defines only a domestic route and a route that settles on Stellar, so
  this leg sequence is a draft reading of the config, not a specified interface
  (contract change request CC-1).
- **Conversion:** `sim_fx` on every cross-border corridor.

No new leg kind is invented, and South Africa is not routed through crypto.

## Open questions and contract-change requests

These are recorded here for the integrator. `docs/CONTRACT_CHANGES.md` is not edited by
this task.

- **CC-1 — bank-only cross-border route is not specified.** §8 builds candidates as the
  domestic rail, the stablecoin route (collect, convert, settle, convert, payout) and the
  anchor route. A cross-border route with no `settle` leg (the only compliant shape for
  South Africa) is not described. Affected: routing engine (CC1), orchestrator (CC2),
  corridor loader (CC0), ZA demo flow DF5. **Missing:** the leg sequence and whether a
  fiat FX payout may run with no settlement leg.
- **CC-2 — leg kind for the domestic rail is not specified.** §8 calls it "the domestic
  rail" but not which leg kind it carries. Affected: routing engine, orchestrator, US
  domestic demo. **Missing:** the leg kind, or confirmation that one `payout` leg is the
  intended shape.
- **Q3 — limit side.** §6.8 says "limits: min and max per payment, per recipient kind"
  without saying whether the amount is the send side or the receive side. This draft uses
  the `to` currency (receive side). Affected: loader validation, routing eligibility,
  batch pre-checks.
- **Q4 — per-kind crypto policy for PH and BR.** No source restricts these corridors, so
  both kinds are `true`. If a restriction is wanted, it is an owner decision on this
  table only.
- **Q5 — crypto endpoint destinations.** `crypto_wallet` and `crypto_custodial` are
  source-defined endpoint types (§6.3) but no corridor here allows them as a destination.
  A corridor that pays out to a crypto endpoint is not scoped by this card.
