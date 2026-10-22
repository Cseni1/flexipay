# Corridors — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet. These tables are the
reviewable content for `config/corridors.json`, written only after the CC0 configuration
schema and loader are merged. This file defines no shared interface and no runtime
behaviour.

**Sources (re-read 22 Oct 2026):** ARCHITECTURE **v4** §6.3 (endpoint types), §6.6 (leg
kinds), §6.8 (corridor fields and baseline corridors), §8 (routing candidates, filters and
the vault fee), §16 (defaults); DEV_PLAN **v4** §4 (SF0 scope); PRODUCT v3 §6 (markets) and
§7 (regulation-aware routing); the SF0-prep task card; the architect decisions of 22 Oct
2026, recorded below as approved simulated demo policy.

**What each value is.** A value is one of three things, and nothing else is written:

- **source-defined** — a cited section states it (the field list, the four baseline
  corridors, the US and South Africa crypto prohibition);
- **approved simulated demo policy** — the architect decided it for this simulated build
  and it is marked as such (per-kind crypto flags for PH and BR, the destination types,
  the leg mappings, the send-side limits);
- **placeholder** — a number, labelled `(placeholder)` or `(simulated placeholder)`, that
  is not a real provider quote or an approved business limit.

Every corridor carries `simulated: true`. The demo policies are policy for a simulated
build, not legal advice and not a claim about current law.

## Conventions used by these tables

- **Money** is an integer in minor units, in double quotes, followed by an explicit ISO
  currency: `"100" USD` means 100 minor units (1.00 USD). No floats, no decimal points,
  no floating-point arithmetic anywhere in the future loader path.
- **`legsAvailable`** maps the source-defined leg kinds (`collect`, `convert`, `settle`,
  `payout`, ARCHITECTURE §6.6) to comma-separated **lists** of provider or rail ids, so
  more eligible providers can be added later without changing the format. `none` means a
  confirmed absence for that leg kind.
- **`domesticRail`** is `none` when `from` and `to` are different countries (§6.8).
- **`(simulated placeholder)`** in a column header marks every value in that column as an
  unapproved draft placeholder.
- Recipient kinds are exactly `individual` and `company` (§6.2). Endpoint types are
  exactly `bank_account`, `ewallet`, `crypto_wallet`, `crypto_custodial` (§6.3).
- **Limits are send-side, in USD minor units, on all four corridors.** The amount compared
  against a limit is the sender's USD amount, not the receive amount. §6.8 does not name
  the side; the send side is the architect decision, and it is recorded here once.

## Table C1 — corridors

| from | to | allowedDestinationTypes | recipientKinds | cryptoLegAllowed.individual | cryptoLegAllowed.company | limits.individual.min (simulated placeholder) | limits.individual.max (simulated placeholder) | limits.company.min (simulated placeholder) | limits.company.max (simulated placeholder) | legsAvailable | domesticRail | regulationNote | simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| US USD | US USD | bank_account | individual, company | false | false | "100" USD | "500000" USD | "100" USD | "5000000" USD | collect: sim_bank_us_ach; convert: none; settle: none; payout: sim_bank_us_ach | sim_bank_us_ach | Domestic USD, same country and currency. Bank account only; no crypto route in this corridor. | true |
| US USD | PH PHP | bank_account, ewallet, crypto_wallet | individual, company | true | true | "100" USD | "500000" USD | "100" USD | "5000000" USD | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_ph_instapay, sim_ewallet_ph | none | Cross-border USD to PHP. Bank account, e-wallet and crypto-wallet destinations; simulated rails only. | true |
| US USD | BR BRL | bank_account, crypto_wallet | individual, company | true | true | "100" USD | "500000" USD | "100" USD | "5000000" USD | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_br_pix | none | Cross-border USD to BRL. Bank account and crypto-wallet destinations. Baseline Latin American country: see the Latin American demo country decision section below. | true |
| US USD | ZA ZAR | bank_account | individual, company | false | false | "100" USD | "500000" USD | "100" USD | "5000000" USD | collect: sim_bank_us_ach; convert: sim_fx; settle: none; payout: sim_bank_za_eft | none | Bank rails only. Draft cross-border crypto rules of 3 Aug 2026 would stop companies sending or receiving crypto across the border; on 21 Oct 2026 the finance minister said they will be rewritten, with no timeline. Demo policy, not legal advice. | true |

Exactly the four baseline corridors in ARCHITECTURE §6.8: US to US, US to Philippines,
US to Brazil and US to South Africa. EU, UK and Mexico are configuration to add after the
event and are **not** written here; no Mexico row or provider exists in this task.

## Crypto destinations — the route ends at settle

For a `crypto_wallet` destination the route ends at the **settle** leg: the vault releases
to the recipient's address and there is **no payout leg**. This is why US to PH and US to
BR list `crypto_wallet` in `allowedDestinationTypes` while their `payout` lists contain
only the fiat providers. A payout is built only for `bank_account` and `ewallet`
destinations.

## Crypto eligibility, per corridor and recipient kind

- **US to US — `false` for both kinds.** Source-defined: the domestic corridor has no
  crypto route.
- **US to ZA — `false` for both kinds.** Source-defined: §6.8 makes South Africa
  "bank only; crypto leg not allowed for companies or individuals until rules are final".
- **US to PH and US to BR — `true` for both kinds.** Approved simulated demo policy (22 Oct
  2026). The sources state the eligibility rule but not these two flags; the architect
  decided them for the demo.
- **`crypto_custodial`** is a source-defined endpoint type (§6.3) that no baseline corridor
  allows. See the open questions.

## Limits — send side, USD, all four corridors

`limits.individual` is min `"100" USD` and max `"500000" USD`; `limits.company` is min
`"100" USD` and max `"5000000" USD`. Every value is a **simulated placeholder**, identical
on all four corridors, and compared against the sender's USD amount.

Provider limits are separate and stay in the provider's own payout currency (for example
`"5000" PHP` on the Philippines bank provider); a single-currency payout provider's limit
is never converted into the corridor's send currency here. The FX provider has no limit of
its own — see `providers.md`.

## South Africa — supplied demo policy

- `cryptoLegAllowed` is `false` for `individual` and for `company`.
- The corridor allows `bank_account` only: no `crypto_wallet` and no `crypto_custodial`
  destination endpoint type.
- `legsAvailable` is `collect: sim_bank_us_ach; convert: sim_fx; settle: none; payout:
  sim_bank_za_eft`. `settle: none` is a confirmed absence: no leg settles on Stellar and
  `stellar_usdc` never appears on this corridor.
- Draft cross-border crypto rules of 3 Aug 2026 would stop companies sending or receiving
  crypto across the border; on 21 Oct 2026 the finance minister said they will be rewritten,
  with no timeline. Until final rules exist, this build routes South Africa over bank rails
  only.
- This is the **supplied demo policy for a simulated corridor**. It is not verified current
  law and not legal advice. It needs local counsel before it is treated as a real market
  rule.
- Demo flow expectation (DF5): a South Africa payment to a company excludes the crypto route
  with a reason naming the recipient kind, and chooses the bank route.

## Leg mapping, as drafted

- **US domestic:** `collect` and `payout` both on `sim_bank_us_ach`; `convert` and `settle`
  are `none`; `domesticRail` is `sim_bank_us_ach` (§6.8).
- **South Africa bank-only cross-border:** `collect` on `sim_bank_us_ach`, `convert` on
  `sim_fx`, `settle` `none`, `payout` on `sim_bank_za_eft`. This is the approved demo
  policy for a corridor with no settlement leg.
- **US to PH and US to BR (crypto route, §8):** `collect` on `sim_bank_us_ach`, `convert` on
  `sim_fx`, `settle` on `stellar_usdc`, `payout` on the corridor's fiat payout providers.
  §8's sequence is collect, convert, settle, convert, payout, so the single `convert` entry
  serves both conversion legs — §6.8 maps ids "per leg kind", not per leg position.
- **Payout providers follow from the six §11.1 providers' countries and endpoint types:**
  `sim_bank_ph_instapay` and `sim_ewallet_ph` for PH, `sim_bank_br_pix` for BR,
  `sim_bank_za_eft` for ZA, `sim_bank_us_ach` for the domestic US payout.

No new leg kind is invented, and South Africa is not routed through crypto.

## Latin American demo country decision — single place

This subsection is the **only** place that records the Latin American demo country.

- **Baseline: Brazil.** ARCHITECTURE §16: "Brazil only in the baseline; Mexico later", and
  DEV_PLAN §4 keeps one Latin American country with Brazil as the default. Brazil is wired
  as the `US USD` to `BR BRL` row above and as the payout provider `sim_bank_br_pix` in
  `providers.md`.
- **Possible replacement: Mexico**, if an owner decision goes the other way.
  ARCHITECTURE §6.8 treats Mexico as configuration added after the event. No Mexico row or
  provider is created in this task.
- **Swap, when owner-approved:** replace the `US USD` to `BR BRL` row with the Mexico
  equivalent and replace the payout provider id with a Mexican bank rail that does not
  exist yet. The leg mapping and limit conventions stay the same; `providers.md` gains the
  new provider row.
- **Who may change it:** only the integrator applies the swap, after the decision.

## Interface note for CC0

`legsAvailable` is one list per corridor and has no per-destination-type filter, but a
`crypto_wallet` destination must stop at `settle` with no `payout` (§ above). The routing
engine can express this from the destination type, but the corridor schema cannot state
"payout applies only to bank and e-wallet destinations". **What:** confirm whether that
rule belongs in the routing engine or needs a corridor field. **Why:** otherwise the
loader has no way to reject a `payout` leg built for a crypto destination. **Affected:**
CC0 config schemas and loader, CC1 routing engine, CC2 orchestrator. This file does not
add the field and does not record a contract-change entry; the integrator records it.

## Open questions

- **Q5 — `crypto_custodial` endpoints.** The type is defined in §6.3 but no baseline
  corridor allows it. Whether any corridor must support it is not stated; it is left out of
  all four rows. Affected: routing eligibility and the endpoint chooser.
- **Interface note above** — where the "no payout for crypto destinations" rule lives.

<!-- draft only; not loaded by code and not a shared interface -->
