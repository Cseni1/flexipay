# Concrete answers for Csaba / Freebuff (from existing E1 handoff)

Does **not** implement API/UI or DF7. Source: `packages/adapter-stellar/E1-HANDOFF.md`, `testnet-ids-anchor-vault.env`, evidence at `badfb0c`.

## Csaba (API / claim UI)

| Question | Answer |
| --- | --- |
| Which package? | `@flexipay/adapter-stellar` on tip that contains `badfb0c`+ |
| Which methods? | `ReferenceAnchorClient` (`connect`, `authenticate`, `startDepositInteractive`, `startWithdrawInteractive`, `getTransaction`, `waitForTerminal`, `paymentExpectationFromTx`), `submitClassicPaymentWithMemo`, `sanitiseHostedUrl`, `assertSuccessfulWithdraw` |
| Which env file for M1 asset/vault? | `scripts/testnet/testnet-ids-anchor-vault.env` — **not** baseline `testnet-ids.env` |
| CCR-20? | **Accepted** (Claude) with renames: `FP_ANCHOR_VAULT_ID`, `FP_ANCHOR_VAULT_FEE_BPS`, `FP_ANCHOR_VAULT_TREASURY_ADDRESS`, `FP_ANCHOR_VAULT_PURPOSE` (+ keep `FP_ANCHOR_HOME_DOMAIN` / `FP_ANCHOR_USDC_ASSET` / `FP_ANCHOR_USDC_CONTRACT_ID`). You propose HTTP request shapes in your PR — **no extra CCR wait** |
| Three server calls to wire | (1) indicative price (2) start withdrawal / hosted URL (3) poll status |
| JWT / hosted URL? | **JWT:** server-only (on `ReferenceAnchorClient`). **Navigation:** browser must get the functional hosted `url` (with session params) via API response or server redirect. **`urlSanitised`:** logs/evidence/safe display only — strips query/hash; not a navigation target. Never log/evidence the functional URL’s sensitive params. |
| Price 502? | One bounded retry of indicative **GET** after diagnosis OK. Never blindly retry withdraw-start **POST** or classic **payment** submit. |
| Treasury? | Must trust GBBD47 USDC or vault claim fee fails (Contract `#13`); setup script covers this |
| What to persist for PASS? | **Three** refs: SEP-24 anchor **transaction id**, **anchor payment hash**, **vault release hash** |
| UI wording | “reference anchor on testnet, pays a US-dollar bank account in a sandbox” |
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
| H1? | Cursor runs after Claude approval; coordinate LOCK on **payer** via EVENT-TX-WINDOWS — do not stop H3/DF7 |
| H3? | Read-only decode — no account LOCK |
