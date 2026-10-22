# Fees — draft content (SF0-prep)

**Status:** draft for review. Nothing here is loaded by code yet and no quote behaviour is
implemented in this task. This is the reviewable content for `config/fees.json`, written
only after the CC0 configuration schema and loader are merged.

**Sources (re-read 22 Oct 2026):** ARCHITECTURE **v4** §6.4 (quote `validUntil`), §6.5
(payment profiles), §8 (the vault's fixed fee for vault-settled routes), §12 (`payout_vault`
fee fixed at deployment; `tip_pool` "tips with no fee"), §16 (defaults); DEV_PLAN **v4** §4;
the architect decisions of 22 Oct 2026.

**What each value is:** the fee structure below is source-defined and architect-confirmed.
Where a source is silent, nothing is invented; the open questions are listed at the end.
Every configurable number is labelled a placeholder. No real price, no real money and no
secrets belong in config.

## The vault fee is the contract's fixed fee, not configuration

- For routes that settle through the vault, FlexiPay charges the **vault's fixed fee, read
  from the contract `config()`**. It is **1 percent = 100 bps**, fixed at deployment in
  `payout_vault`.
- It is **not** a `fees.json` placeholder, **not** an extra fee on top of anything, and must
  never be duplicated in configuration: one value, on-chain, so a quote cannot disagree with
  what is charged.
- ARCHITECTURE §8: "For routes that settle through the vault, the FlexiPay fee is the
  vault's fixed fee, read from the contract (`config()`), so it cannot differ from what is
  charged on-chain; `fees.json` sets the fee only for legs outside the vault." §16 states the
  same default.

## Configurable fees — outside-vault legs only

The only configurable fee values in these drafts are the per-leg charges of legs that do not
settle through the vault:

- the US domestic rail `sim_bank_us_ach`;
- the FX conversion leg `sim_fx`;
- the simulated bank and e-wallet payout providers.

They are recorded **once**, in `providers.md`, as labelled placeholders (`feeFixed`,
`feeBps`, `fxSpreadBps`). This file does not restate them, does not scale them and does not
add a FlexiPay margin on top: no source defines such a margin, so none is written. A leg is
charged by one party, never twice.

| leg | who charges | where the value lives |
|---|---|---|
| settle through the vault | the contract's fixed fee, set at deployment | `payout_vault` `config()`, fixed at 1 percent |
| US domestic rail | the simulated provider | `providers.md`, `sim_bank_us_ach` |
| conversion | the simulated FX provider | `providers.md`, `sim_fx` |
| payout | the simulated bank or e-wallet provider | `providers.md`, `sim_bank_*` and `sim_ewallet_ph` |

## Tips

Tips carry no per-tip FlexiPay fee: **0 bps** (placeholder). Sources: ARCHITECTURE §12
(`tip_pool`: tips with no fee) and §6.5 (the `tips` profile). The tips module is a stretch
goal and its plan price is out of scope for this task, so no amount is stated.

## Quote validity (not a fee)

`quoteValiditySeconds` = 120 (placeholder) — ARCHITECTURE §6.4 (`validUntil`, "Default 120
seconds in the demo") and §16 ("Quote validity | 120 seconds; sender bears price movement
and re-quotes on expiry"). Recorded only; expiry, countdowns and re-quoting belong to the
quote and orchestrator tasks.

## Money representation

When a monetary value is written in these config drafts, it is an **integer in minor units,
in double quotes, with an explicit currency**: the quoted integer is the minor-unit amount
and the following code is the ISO currency. Percentages are **integer basis points**
(100 bps = 1.0 percent). No floats, no decimal points and no floating-point arithmetic.
This file deliberately writes no monetary value at all, so there is nothing here to restate
or duplicate.

## Open questions

- **Q-fee-side.** Which side the fixed vault fee is deducted from, for display purposes, is
  not stated. No receive amount is published on the strength of an assumption here.
- **Q-rounding.** How the contract rounds a fee that is not an exact division is a contract
  matter. `contracts/payout_vault/RULES.md` is the spec (ARCHITECTURE §12) and is not in this
  working copy, so no rounding rule is assumed.
- **Q-margin.** Whether `fees.json` should carry any FlexiPay margin for outside-vault legs
  is not specified; none is written until it is.

<!-- draft only; not loaded by code and not a shared interface -->
