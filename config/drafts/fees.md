# Fees — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet and no quote behaviour is
implemented in this task. This is the reviewable content for `config/fees.json`, written
only after the CC0 configuration schema and loader are merged.

**Sources (re-read 22 Oct 2026, current copies):** ARCHITECTURE v3 §6.4 (quote
`validUntil`), §6.5 (payment profiles), §8 (the vault's fixed fee for vault-settled
routes), §12 (`tip_pool`: "tips with no fee"), §16 (open decisions: FlexiPay fee shown,
quote validity); the SF0-prep task card.

**Confirmed vs unresolved:** the percentages below are source-defined defaults. Anything a
source leaves open is `TBD` and listed in the blockers section; it is not an approved
value. Every number that is present is a **draft placeholder**, including the zeros — not
an approved price, not a business model and not a real provider quote. The demo must show
the "Simulated" label wherever a fee is displayed.

## Standard FlexiPay fee

One standard placeholder, applied to every non-tips profile:

**1.0 percent = 100 bps** (placeholder)

ARCHITECTURE §16: "FlexiPay fee shown — 1.0 percent placeholder from `fees.json`". There is
no profile-specific pricing and no monthly-plan amount in this task.

**Scope of this value (§8).** For routes that settle through the vault, the FlexiPay fee
is the vault's fixed fee, read from the contract `config()`, so it cannot differ from what
is charged on-chain; `fees.json` sets the fee only for legs outside the vault. This file
therefore records the standard placeholder for the non-vault case only. Whether the two
must be equal is not stated by the sources and is not decided here.

## Conventions

- Percentages are **integer basis points**: 100 bps = 1.0 percent. No fractional bps.
- Money is an **integer in minor units, in double quotes, with an explicit currency**:
  `"1000" USD` is 1000 minor units (10.00 USD). No floats anywhere.
- `percentLabel` is a human-readable display string, never a value to compute with. The
  basis-point column is the only source of truth.
- `(placeholder)` in a column header marks every value in that column as an unapproved
  draft placeholder.
- Sums are done with integer arithmetic in the future code path (BigInt where a
  comparison or a multiplication by bps is involved); no floating-point maths.
- **`TBD`** means unresolved: blocked on an integrator answer, never a guess.

## Table F1 — FlexiPay fee per profile

The six profiles are exactly the §6.5 `payment.profile` values. `tips` is the
source-defined exception at 0 bps.

| profile | flexipayFeeBps (placeholder) | percentLabel | placeholder | simulated | source |
|---|---|---|---|---|---|
| small | 100 | 1.0 percent | true | true | ARCHITECTURE §16 standard fee placeholder |
| batch | 100 | 1.0 percent | true | true | ARCHITECTURE §16 standard fee placeholder |
| invoice | 100 | 1.0 percent | true | true | ARCHITECTURE §16 standard fee placeholder |
| tips | 0 | 0.0 percent | true | true | ARCHITECTURE §6.5 and §12: tips carry no FlexiPay fee |
| domestic | 100 | 1.0 percent | true | true | ARCHITECTURE §16 standard fee placeholder |
| one_off | 100 | 1.0 percent | true | true | ARCHITECTURE §16 standard fee placeholder |

Notes:

- The tips exception is 0 bps: the tip pool charges the tips module's own plan, not a
  per-tip FlexiPay fee (§12). The tips plan amount is out of scope for this task and is
  not stated here.
- No profile is priced differently from the standard placeholder. If a differential tier
  is wanted later, it is an owner decision and a change to this table only.

## Quote validity (source default, not implemented)

`quoteValiditySeconds` = 120 (placeholder) — ARCHITECTURE §6.4 (`validUntil`, "Default 120
seconds in the demo") and §16 ("Quote validity — 120 seconds; sender bears price movement
and re-quotes on expiry").

This task only records the default. Expiry behaviour, countdowns and re-quote handling
belong to the quote and orchestrator tasks and are not implemented here.

## Table F2 — money representation example (illustrative)

A worked example showing the required money representation. It is illustrative only and
establishes no price. The fee is exact in integer arithmetic:
`"100000" USD` x 100 bps / 10000 = `"1000" USD`, with no remainder.

| key | value | placeholder | note |
|---|---|---|---|
| exampleSendAmount | "100000" USD | true | illustrative only, 100000 minor units = 1000.00 USD |
| exampleFlexiPayFeeBps | 100 | true | the standard fee from Table F1 |
| exampleFlexiPayFee | "1000" USD | true | 100000 x 100 / 10000, exact integer result |
| exampleExpectedReceiveIndicator | TBD | true | unresolved: which side the fee is charged on is not stated, so no receive amount is published (Q9) |

The send amount, the bps and the fee are exact integer arithmetic. The receive figure is
deliberately absent: publishing one would decide whether the fee is deducted from the send
or the receive side, and would also need FX rates and leg fees, which are CC0 and CC1
interface work.

## Blockers — unresolved cells (not approved configuration)

| cells | why unresolved | question | decided by |
|---|---|---|---|
| exampleExpectedReceiveIndicator | the side the FlexiPay fee is charged on is not stated, so no receive amount can be computed | Q9 | integrator |
| every non-exact fee calculation | no source defines how a fee whose amount x bps is not divisible by 10000 is rounded | Q8 | integrator |

## Not in scope

- No monthly-plan amount and no tips-plan price.
- No profile-specific pricing beyond the single standard placeholder.
- No provider fees or FX spreads here; those live in `providers.md` and are placeholders
  too.
- No JSON file, no loader, no zod schema and no fee calculation code.

## Open questions (for the integrator; `docs/CONTRACT_CHANGES.md` is not edited here)

- **Q8 — rounding rule.** Affected: fee calculation, quote `fees` breakdown (§6.4), invoice
  and batch totals. Until it is defined, this draft only uses an exact example and must not
  be read as a rounding policy.
- **Q9 — whether the FlexiPay fee is charged on the send side or the receive side.**
  Affected: quote `expectedReceive`, dashboard display, claim page amount, and whether the
  `fees.json` placeholder and the vault's fixed fee must match.
