# H1 — Stellar fee-drift reproduction (**Claude approved** 25 Oct 2026)

**Status: APPROVED — configuration drift between vaults (100-bps baseline quote → 50-bps isolated same-token vault), not an on-chain fee mutation of the baseline vault.**  
**Driver (gated):** `scripts/demo/h1-fee-drift-stellar.ts`  
**Mock reference (already PASS):** `scripts/demo/evidence/2026-10-23-ccr15-recovery-c859c92.md` + `apps/api/test/ccr15-public-api.test.ts`  
**Baseline vault:** leave `FP_PAYOUT_VAULT_ID=CCG232…` / fee **100** untouched in `testnet-ids.env`.

## Exact reproduction (approved)

1. Deploy an **isolated same-token** vault (GBBO6N USDC SAC = baseline token), `fee_bps=50`, distinct contract id / alias `fp-payout-vault-h1`. Write public ids only to `scripts/testnet/testnet-ids-h1-vault.env` (never overwrite baseline ids).
2. Isolated embedded Postgres + dedicated Demo Platform org/key (not the shared demo DB).
3. **Process A** (`FP_SETTLEMENT=stellar`, baseline vault env, fee evidence 100): create `claim_link` payment (quote freezes flexiPayFee at 100 bps). Do **not** fund yet if the design requires restart-before-fund; match mock evidence: quote+create under 100, then restart.
4. **Process B** (same `DATABASE_URL` + same `FP_CLAIM_SEAL_KEY`; env points at **H1 vault** so `verifyConfig` / `feeBps()` = 50): `POST /v1/payments/{id}/fund`.
5. Assert public API + durable state (below). Restore baseline env afterward. Clean up: stop isolated DB; do not merge H1 vault into baseline ids.

## Expected public-API behaviour

| Step | Expectation |
| --- | --- |
| Fund under drifted vault | **409** `fee_drift` |
| Payment after drift | **`refunded`** (never `paid`) |
| Settle leg | `failed`, `errorCode=fee_drift`; **retain** `externalRef` (payoutId) + `lockTxRef`; `releaseTxRef` = **refund/cancel** hash |
| Claim view | claim stays **`open`**; `paymentStatus: refunded` |
| Claim accept | **409** `settle_failed` (funds returned; no release) |
| Replay fund | **200** idempotent / still `refunded` — **no** second lock |
| Replay accept | **409** `settle_failed` again |
| Events | exactly **one** lock + **one** refund; no `payment.paid` |

## On-chain checks (Stellar)

- Decode lock tx = `create_payout` for that payoutId at H1 vault.
- Decode refund tx = vault cancel/refund for **same** payoutId; payment never released to recipient.
- Replay must not create additional create_payout / refund invocations for this payment.

## Isolation / cleanup

- DB: `apps/api/.pgdata-h1-drift` (gitignored), distinct API port.
- Tx windows: LOCK payer (fund/lock/refund) with Freebuff before live submits; UNLOCK when done.
- Secrets: local only; no tokens in evidence.
- After run: evidence file under `scripts/demo/evidence/`; delete private claim token; leave baseline `testnet-ids.env` unchanged.

## Driver modes (no accidental run)

```bash
# default — print plan + checks only (safe)
node scripts/demo/h1-fee-drift-stellar.ts

# optional prepare — deploy H1 vault + write public ids (still not the fund/drift scenario)
FP_H1_PREPARE_VAULT=1 node scripts/demo/h1-fee-drift-stellar.ts

# execute — ONLY after Claude approval
FP_H1_CLAUDE_APPROVED=1 FP_H1_EXECUTE=1 node scripts/demo/h1-fee-drift-stellar.ts
```
