# Shared testnet transaction windows (E1 ↔ Freebuff)

**Owner of `testnet-ids-anchor-vault.env`:** Csenge Cursor (this lane).  
**Consumer:** Freebuff (DF7 / H3). Do not regenerate or overwrite the file without coordinating.

Shared classic accounts (from baseline identities, also listed in the event ids file once generated):

| Role | Address env |
| --- | --- |
| Payer (funds vault #2 / deposits) | `FP_PAYER_DEMO_ADDRESS` |
| Recipient A (SEP-10 + withdraw / claim) | `FP_RECIPIENT_A_ADDRESS` |

## Rule

**Only one agent submits Horizon/Soroban transactions for a given account at a time.** Sequence number races will fail submissions.

1. Before any live tx, post in the coordinating chat: `LOCK <account-role> <agent> <purpose> <UTC start>`.
2. Hold the lock until the tx confirms or you abort; then `UNLOCK <account-role> <agent>`.
3. Prefer: Cursor owns **payer** during deposit + vault fund/lock; Freebuff owns **recipient A** during SEP-10 withdraw / DF7 accept payment. Do not overlap.
4. H3 decode (Freebuff) is read-only RPC — no lock required.
5. Never use baseline vault `FP_PAYOUT_VAULT_ID` for M1 anchor-asset flows.

## Suggested order (M1 funding)

1. Cursor: generate `testnet-ids-anchor-vault.env` (`setup-anchor-vault.sh`).
2. Cursor LOCK payer → SEP-24 deposit (1–10 USDC GBBD47) → vault #2 deposit → UNLOCK.
3. Freebuff LOCK recipient A → DF7 withdraw path (or Cursor for SEP-10 checkpoint) → classic memo payment from recipient → UNLOCK.

## Done (Cursor, 25 Oct ~11:19–11:24Z)

Package path completed under LOCK rules (payer then recipient A). Evidence: `scripts/demo/evidence/2026-10-25-e1-deposit-vault-withdraw.md`. Freebuff may reuse balances/hashes for DF7/H3 decode; coordinate before overlapping live submits on the same accounts.
