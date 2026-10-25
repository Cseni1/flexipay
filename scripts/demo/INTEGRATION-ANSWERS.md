# Concrete answers for Csaba / Freebuff (from existing E1 handoff)

Does **not** implement API/UI or DF7. Source: `packages/adapter-stellar/E1-HANDOFF.md`, `testnet-ids-anchor-vault.env`, evidence at `badfb0c`.

## Csaba (API / claim UI)

| Question | Answer |
| --- | --- |
| Which package? | `@flexipay/adapter-stellar` on tip that contains `badfb0c`+ |
| Which methods? | `ReferenceAnchorClient` (`connect`, `authenticate`, `startDepositInteractive`, `startWithdrawInteractive`, `getTransaction`, `waitForTerminal`, `paymentExpectationFromTx`), `submitClassicPaymentWithMemo`, `sanitiseHostedUrl`, `assertSuccessfulWithdraw` |
| Which env file for M1 asset/vault? | `scripts/testnet/testnet-ids-anchor-vault.env` — **not** baseline `testnet-ids.env` |
| CCR-20? | Env **names** proposed; Claude approval **pending**. You may read the public ids file locally; do not bind new HTTP contract fields until CCR-20 is accepted |
| JWT / hosted URL? | Server-only. Browser/logs/evidence get `urlSanitised` only |
| Treasury? | Must trust GBBD47 USDC or vault claim fee fails (Contract `#13`); setup script covers this |
| What to persist for PASS? | Vault **release** hash and anchor **classic payment** hash / SEP-24 `stellar_transaction_id` as **separate** fields |
| Duplicate payment? | One classic submit; on poll timeout reconcile Horizon by that hash before any retry |
| Integrated M1? | **PARTIAL** until your claim journey wires the above |

## Freebuff (DF7 / H3)

| Question | Answer |
| --- | --- |
| Which commit to verify against? | **`badfb0c`** for package-path anchor PASS; H2 evidence at **`b3b3802`** (do not rebuild E1) |
| Evidence file? | `scripts/demo/evidence/2026-10-25-e1-deposit-vault-withdraw.md` |
| Client? | Same `@flexipay/adapter-stellar` exports as above |
| Re-fund deposit? | Prefer reuse; if you must live-submit, LOCK payer/recipientA per `EVENT-TX-WINDOWS.md` |
| Baseline vault? | Untouched for M1; H2 used baseline for seal-key only |
| H1? | Not your run; Cursor waits on Claude. Coordinate LOCK if Cursor executes later |
| H3? | Read-only decode — no account LOCK |
