# Corridors — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet. These tables are the
reviewable content for `config/corridors.json`, which is written only after the CC0
configuration schema and loader are merged. This file defines no shared interface and no
runtime behaviour.

**Sources (re-read 22 Oct 2026, current copies):** ARCHITECTURE v3 §6.3 (endpoint types),
§6.6 (leg kinds), §6.8 (corridor fields and the baseline corridor list), §8 (routing
eligibility and optimisation), §16 (defaults); DEV_PLAN v3 §4 (trimmed SF0 scope);
PRODUCT v3 §6 (markets) and §7 (regulation-aware routing); the SF0-prep task card.

**Confirmed vs unresolved:** a value is only written as configuration where a source
states it. Space that a source leaves open is written `TBD` and listed in the blockers
section at the end; it is **not** an approved value and the checker does not validate it
as policy. Every number that is present is a **draft placeholder** — including zeros —
never a real provider quote or an approved business limit. Every corridor is simulated
demo data (`simulated: true`).

## Conventions used by these tables

- **`TBD`** means unresolved: blocked on an integrator answer, never a placeholder to be
  guessed. A `TBD` cell carries no amount, currency or provider.
- **Money** is an integer in minor units, in double quotes, followed by an explicit ISO
  currency: `"100" USD` means 100 minor units (1.00 USD). No floats, no decimal points,
  no floating-point arithmetic anywhere in the future loader path.
- **`legsAvailable`** maps the source-defined leg kinds (`collect`, `convert`, `settle`,
  `payout`, ARCHITECTURE §6.6) to comma-separated **lists** of provider or rail ids, so
  more eligible providers can be added later without changing the format. `none` means a
  confirmed absence; `TBD` means the mapping is unresolved.
- **`domesticRail`** is `none` when `from` and `to` are different countries (§6.8).
- **`(placeholder)`** in a column header marks every value in that column as an
  unapproved draft placeholder.
- Recipient kinds are exactly `individual` and `company` (§6.2). Endpoint types are
  exactly `bank_account`, `ewallet`, `crypto_wallet`, `crypto_custodial` (§6.3).
- **Limits carry no value while the side is undefined.** A per-payment limit must state a
  currency, and §6.8 does not say whether that amount is the send side or the receive
  side, so every limit cell is `TBD` (question Q3). See the blockers section.

## Table C1 — corridors

| from | to | allowedDestinationTypes | recipientKinds | cryptoLegAllowed.individual | cryptoLegAllowed.company | limits.individual.min (placeholder) | limits.individual.max (placeholder) | limits.company.min (placeholder) | limits.company.max (placeholder) | legsAvailable | domesticRail | regulationNote | simulated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| US USD | US USD | bank_account | individual, company | false | false | TBD | TBD | TBD | TBD | collect: TBD; convert: TBD; settle: none; payout: sim_bank_us_ach | sim_bank_us_ach | Domestic USD, same country and currency. Bank account only; no crypto route in this corridor. | true |
| US USD | PH PHP | bank_account, ewallet | individual, company | TBD | TBD | TBD | TBD | TBD | TBD | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_ph_instapay, sim_ewallet_ph | none | Cross-border USD to PHP. Bank account and e-wallet destinations; simulated rails only. | true |
| US USD | BR BRL | bank_account | individual, company | TBD | TBD | TBD | TBD | TBD | TBD | collect: sim_bank_us_ach; convert: sim_fx; settle: stellar_usdc; payout: sim_bank_br_pix | none | Cross-border USD to BRL. Bank account only. Baseline Latin American country: see the Latin American demo country decision section below. | true |
| US USD | ZA ZAR | bank_account | individual, company | false | false | TBD | TBD | TBD | TBD | collect: TBD; convert: TBD; settle: none; payout: sim_bank_za_eft | none | Bank rails only. Draft cross-border crypto rules of 3 Aug 2026 are being rewritten with no timeline; demo policy, not legal advice. | true |

Exactly the four baseline corridors in ARCHITECTURE §6.8: US to US, US to Philippines,
US to Brazil and US to South Africa. EU, UK and Mexico are configuration to add after the
event and are **not** written here; no Mexico row or provider exists in this task.

## Crypto eligibility, per corridor and recipient kind

Eligibility is per recipient kind (§6.8), which is why there is one column per kind. A
`false` is written only where a source states it.

- **US to US — `false` for both kinds.** The task card: the domestic corridor has no
  crypto route.
- **US to ZA — `false` for both kinds.** §6.8 and PRODUCT §7: bank only, crypto leg not
  allowed for companies or individuals until the rules are final.
- **US to PH and US to BR — unresolved, `TBD` for both kinds (Q4).** §8 builds the
  stablecoin route as a candidate in every corridor and filters it by
  `cryptoLegAllowed`, but no source states whether PH and BR allow it per recipient kind.
  Writing `true` would assert a per-kind crypto policy nobody has approved; writing
  `false` would invent a restriction that would remove the product's main route. Neither
  is done. The `settle: stellar_usdc` entry in `legsAvailable` records the §8 route shape
  only; whether it may run for a given kind is the unanswered flag.

## Limits — withheld until the side is defined

All sixteen limit cells are `TBD` (Q3). §6.8 requires "min and max per payment, per
recipient kind" without saying whether the amount is the send side or the receive side,
and every amount must carry a currency. Recording USD figures would decide the side as a
side effect, so no monetary value is written. The per-kind columns stay in place so the
values drop in unchanged once the answer is recorded.

## South Africa — supplied demo policy

- `cryptoLegAllowed` is `false` for `individual` and for `company`.
- The corridor allows `bank_account` only: no `crypto_wallet` and no `crypto_custodial`
  destination endpoint type.
- `legsAvailable` contains **no** `settle` provider and never references `stellar_usdc`
  (`settle: none` is a confirmed absence, not a placeholder).
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

- **Cross-border crypto route (§8), PH and BR:** `collect` on `sim_bank_us_ach`,
  `convert` on `sim_fx`, `settle` on `stellar_usdc`, `payout` on the corridor's payout
  providers. §8's sequence is collect, convert, settle, convert, payout, so the single
  `convert` entry serves both conversion legs — §6.8 maps ids "per leg kind", not per leg
  position.
- **US domestic:** the payout rail `sim_bank_us_ach` is confirmed by §6.8 (`domesticRail`)
  and the task card, and `settle: none` follows from "no crypto route". **`collect` and
  `convert` are `TBD` (CC-2):** §8 calls the domestic route "the domestic rail" without
  naming its leg kind, so whether it is one `payout` leg or a collect plus payout is not
  specified and is not guessed here.
- **South Africa bank-only cross-border:** `payout: sim_bank_za_eft` and `settle: none` are
  confirmed (bank-only corridor, ZA EFT is the installed provider). **`collect` and
  `convert` are `TBD` (CC-1):** §8 defines only a domestic route, a route that settles on
  Stellar, and the anchor route, so a cross-border route with no `settle` leg has no
  specified leg sequence.
- **Conversion:** `sim_fx` on every cross-border corridor.

No new leg kind is invented, and South Africa is not routed through crypto.

## Latin American demo country decision — single place

This subsection is the **only** place that records the Latin American demo country.

- **Baseline:** Brazil. ARCHITECTURE §16 now says "Brazil only in the baseline; Mexico
  later", and DEV_PLAN §4 keeps one Latin American country with Brazil as the default.
  Brazil is wired as the `US USD` to `BR BRL` row above and as the payout provider
  `sim_bank_br_pix` in `providers.md`.
- **Possible replacement:** Mexico, if the owner decision due Friday 10:00 (DEV_PLAN §4)
  goes the other way. ARCHITECTURE §6.8 treats EU, UK and Mexico as configuration added
  after the event. No Mexico row or provider is created in this task.
- **Swap, when owner-approved:** replace the `US USD` to `BR BRL` row with the Mexico
  equivalent and replace the payout provider id with a Mexican bank rail that does not
  exist yet. The leg mapping and limit conventions stay the same; `providers.md` gains the
  new provider row.
- **Who may change it:** only the integrator applies the swap, after the decision.

## Blockers — unresolved cells (not approved configuration)

| cells | why unresolved | question | decided by |
|---|---|---|---|
| cryptoLegAllowed.individual and cryptoLegAllowed.company on US to PH and US to BR | no source states per-kind crypto permission for these corridors | Q4 | integrator |
| limits.individual.min, limits.individual.max, limits.company.min, limits.company.max on all four corridors | §6.8 does not say whether the per-payment limit is the send side or the receive side, and an amount needs a currency | Q3 | integrator |
| collect and convert on US to US | §8 names the domestic rail without naming its leg kind | CC-2 | integrator |
| collect and convert on US to ZA | §8 has no cross-border route without a settle leg | CC-1 | integrator |

## Contract-change requests and open questions

Recorded for the integrator. `docs/CONTRACT_CHANGES.md` is not edited by this task.

- **CC-1 — bank-only cross-border route is not specified.** §8 builds candidates as the
  domestic rail, the stablecoin route (collect, convert, settle, convert, payout) and the
  anchor route. A cross-border route with no `settle` leg, the only compliant shape for
  South Africa, is not described. Affected: routing engine (CC1), orchestrator (CC2),
  corridor loader (CC0), ZA demo flow DF5. **Missing:** the leg sequence and whether a
  fiat FX payout may run with no settlement leg.
- **CC-2 — leg kind for the domestic rail is not specified.** §8 calls it "the domestic
  rail" but not which leg kind it carries. Affected: routing engine, orchestrator, US
  domestic demo. **Missing:** the leg kind, or confirmation that one `payout` leg is the
  intended shape.
- **Q3 — limit side.** As above. Affected: loader validation, routing eligibility, batch
  pre-checks, `/v1/corridors`.
- **Q4 — per-kind crypto policy for PH and BR.** As above. Affected: routing eligibility
  and the reasons shown in the UI.
- **Q5 — crypto endpoint destinations.** `crypto_wallet` and `crypto_custodial` are
  source-defined endpoint types (§6.3) but no baseline corridor allows them as a
  destination. A corridor that pays out to a crypto endpoint is not scoped by this task.
