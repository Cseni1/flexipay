# SDK fee-construction fix (vault-client write path) — for Claude

**Branch:** `event/csenge-cursor/sdk-fee-build`  
**Scope:** `packages/adapter-stellar` vault write path only. No orchestrator / deposit recovery.

## Change

Replace `AssembledTransaction.signAndSend()` with:

1. `TransactionBuilder.cloneFrom(tx.built, { timebounds: undefined, sorobanData: tx.simulationData.transactionData })` — **no `fee` override**
2. `.setTimeout(...)` then `.build()`
3. Validate inclusion + resource **once**, uint32 range, configured ceiling (typed `VaultTxFeeError`; never cap/truncate)
4. `rebuilt.sign(signer)` + `tx.send()` (preserves existing result/`toVaultError` decoding)

## SDK API check

Inspected `@stellar/stellar-sdk` 16.4.0:

- `AssembledTransaction.sign()` still does `cloneFrom(..., { fee: this.built.fee, ... })` then `build()` → double-counts `resourceFee`.
- Claude’s proposed call (no fee override) matches `cloneFrom`’s strip-then-add behavior; sim compare records whether rebuilt fee equals assembled fee (exit 2 on discrepancy).

## Ceiling (needs Claude confirmation)

- Env name added to `.env.example`: **`FP_SOROBAN_TX_FEE_CEILING_STROOPS`**
- Loaded as `StellarEnv.sorobanTxFeeCeilingStroops` (`null` when unset)
- Writes fail with `VaultTxFeeError` reason `ceiling_not_configured` until set
- **No default invented in code** — please confirm name + default stroops value

## Tests

- Unit: `packages/adapter-stellar/test/vault-tx-fee.test.ts` — old double-count overflows uint32 for diagnosis-time R≈2.82e9; single-count fits; ceiling typed failures
- Full `@flexipay/adapter-stellar` vitest: 56 passed / 5 skipped (testnet opt-in)
- Sim-only (no sign/submit): `scripts/demo/sdk-fee-build-sim-compare.mjs` → `2026-10-25-sdk-fee-build-sim.json`

| Metric | Value |
|--------|-------|
| RPC minResourceFee | 692 289 |
| Assembled `built.fee` | 692 389 |
| Legacy rebuild (`fee: built.fee`) | **1 384 678** (= assembled + R) |
| Build-once rebuild (Claude proposal) | **692 389** (= assembled; no discrepancy) |
| Historical R≈2.82e9 legacy total | 5 641 973 166 > uint32 (unit regression) |

## Decision for Claude

1. ACK or rename `FP_SOROBAN_TX_FEE_CEILING_STROOPS` and set the default stroop ceiling.
2. Confirm build-once fee matches assembled in the sim evidence (or note SDK discrepancy).
3. Do not merge recovery/`/fund` until ceiling is confirmed and this path is reviewed.
