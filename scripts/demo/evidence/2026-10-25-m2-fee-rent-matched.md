# M2 matched fee/rent diagnosis (Assignment 1, read-only) — for Claude

**Tested commit:** `729e67f` (main after #72)  
**Machine JSON:** `2026-10-25-m2-fee-rent-matched.json`  
**No transactions submitted. No DB mutations. No `signAndSend` / `send`.**

---

## 1. Expected rent (formula, units, assumptions)

**Sources:** [`rs-soroban-env/src/fees.rs`](https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/fees.rs) (`compute_rent_write_fee_per_1kb`, `rent_fee_for_size_and_ledgers`, `compute_rent_fee`); [CAP-0046-07 Rent fee](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0046-07.md).  
**Units:** stroops; sizes in bytes; ledgers dimensionless.

### Network settings (RPC `getLedgerEntries`)

| Field | Value | Source |
|-------|-------|--------|
| `sorobanStateTargetSizeBytes` | **7 000 000 000** | ConfigSettingContractLedgerCostV0 |
| `rentFee1KbSorobanStateSizeLow` | **-17 000** | same |
| `rentFee1KbSorobanStateSizeHigh` | **10 000** | same |
| `sorobanStateRentFeeGrowthFactor` | **5000** | same |
| `feeWriteLedgerEntry` | 1250 | same |
| `feeWrite1Kb` | 437 | ConfigSettingContractLedgerCostExtV0 |
| `persistentRentRateDenominator` | 1215 | StateArchivalSettings |
| `tempRentRateDenominator` | 2430 | same |
| LiveSorobanStateSizeWindow (latest) | **~4.158e9** bytes | ConfigSettingLiveSorobanStateSizeWindow |

### Growth factor is not a direct multiplier

`sorobanStateRentFeeGrowthFactor` multiplies **only** the post-target slope inside:

```
fee_per_rent_1kb = f(soroban_state_size_bytes)
```

With **state ≈ 4.16e9 < target 7e9**, the post-target / growthFactor branch **does not apply**. Interpolated rate is negative and clamps to **`MINIMUM_RENT_WRITE_FEE_PER_1KB = 1000`**.

### Vault TTL constants

From `contracts/payout_vault/src/lib.rs`: `DAY_LEDGERS=17280`, `TTL_THRESHOLD=30×day`, **`TTL_BUMP=60×day=1 036 800` ledgers**.

### Calculated rent for this dry-run’s `create_payout` (assumptions stated)

For each **created** persistent entry (sizes = encoded LedgerEntry XDR length from simulate `stateChanges.after`):

| Entry | Size (XDR bytes) | Assumed L | fee_per_rent_1kb | Rent (stroops) |
|-------|------------------|-----------|------------------|----------------|
| created contractData | 180 | TTL_BUMP 1036800 | 1000 | **150 000** |
| created contractData | 524 | TTL_BUMP 1036800 | 1000 | **436 667** |
| **sum** | | | | **586 667** |

**RPC `minResourceFee` (same probe):** **692 289**  
Difference ≈ 105 622 → leftover consistent with non-rent resources + updated-entry TTL writes (not fully closed without exact `live_until` before/after).

**Limitations:**  
1. `live_until` before/after live on separate TTL keys — not fully resolved per entry.  
2. Encoded XDR length may differ from host in-memory size.  
3. **Earlier today** minResourceFee was **~2.9e9** (evidence #72); **not reproduced now** (stable ~6.9e5 for matched and random external ids). Cause of that swing is **not measured** in this assignment.

---

## 2. API build path dry-run (exact claim inputs; no submit)

Payment `pay_b61ffbace8fe4a8b1397ad38` (DB `lockAttempt=3`, claim expired 17:12Z).

| Input | Source |
|-------|--------|
| `claim_hash` | `claimLink.vaultClaimHashHex` (exact) |
| `amount` | settle `19702970` |
| `mode` | quote `PayerPays` |
| `payer` | demo payer |
| `external_id` | `sha256(paymentId:lockAttempt)` |

**Exact `expires_at`:** simulate → contract **`#11 InvalidExpiry`** (claim past). No resource fee.  

**Fee-measure deviation (only):** `expires_at = now+3600`; all other inputs exact.

| Step | Value | Source |
|------|-------|--------|
| RPC `minResourceFee` | **692 289** | simulate |
| XDR `resourceFee` | 692 289 | Soroban tx data |
| Assembled `built.fee` | **692 389** | Client assemble (= 100 + R) |
| `sign()`-equivalent rebuild | **1 384 678** | `TransactionBuilder.cloneFrom({ fee: built.fee, sorobanData }).build()` — **no sign, no send** |
| `cloneFrom` without fee override | 692 389 | same R, stripped inclusion works |

**SDK mechanism (measured, inspect-only):**  
`AssembledTransaction.sign()` overrides cloneFrom fee with full `built.fee` (already inclusion+R); `build()` adds `resourceFee` again → **total = assembled + R**.  
`signAndSend` was **not** called (would submit after sign).

---

## 3. 5.26e9 vs ~2.91e9 — measured only

| Quantity | Value | Status |
|----------|-------|--------|
| API error Got | **5 261 104 576** | API error string only (historical) |
| Diagnosis-script R / assembled | 2 820 986 533 / 2 820 986 633 | prior evidence |
| Diagnosis assembled + R | **5 641 973 166** | ≠ Got |
| Speculative 2 820 986 533 + 2 440 118 043 | equals Got | **RETIRED** — second addend was not an RPC/SDK field |
| R that would make (100+R)+R = Got | **≈ 2 630 552 238** | arithmetic only; not measured at failure time |
| This dry-run sign rebuild | assembled + R (measured) | mechanism confirmed; numbers differ because R moved |

**Correction to** `2026-10-25-m2-fee-overflow-diagnosis.md` **§ interpretation:** the “second large addend / restore composition” sentence is speculative and withdrawn. Historical record of measured R/assembled/Got strings is preserved.

---

## 4. Stellar-mentor question (precise)

> On Test SDF Network, `LiveSorobanStateSizeWindow` ≈ 4.1e9 bytes with `sorobanStateTargetSizeBytes=7e9` so `growthFactor=5000` is inactive and `fee_per_rent_1kb` floors at 1000; our created-entry rent estimates then nearly match today’s `minResourceFee≈6.9e5`. Earlier the same `create_payout` shape returned `minResourceFee≈2.9e9`. What host inputs drive that swing, and does `SimulateTransaction` expose a rent-only fee breakdown / authoritative entry size + `live_until` vectors? Also: is stellar-sdk `AssembledTransaction.sign()`’s `cloneFrom({ fee: built.fee })` double-adding `resourceFee` (overflowing uint32 when R ≳ 2.15e9) expected?

---

## 5. Decision Claude needs

1. **Treat current rent math as explained** under below-target / floor-1000 rates for *today’s* sims; **do not** treat growthFactor=5000 as the active multiplier while state &lt; 7e9.  
2. **Treat SDK `sign()` fee rebuild double-count as measured** — likely overflow path whenever `assembled + resourceFee > uint32_max` (historically when R ≳ ~2.15e9).  
3. **Do not** implement recovery / fee policy / TTL / redeploy from this lane — Csaba owns CCR/orchestrator.  
4. Decide whether to pursue (a) SDK/sign-path uint32 handling, (b) mentor clarification on the earlier ~2.9e9 spike, and/or (c) vault TTL strategy — before any `/fund` retry (still re-deposits).

**M2:** NOT VERIFIED · **Freebuff:** paused · **No txs.**
