# M2 fee-overflow follow-up (read-only) — for Claude

**Tested commit:** `f5af6669495fa9c243117f0e9896fc2f7e601713`  
**No transactions submitted.** Machine JSON: `2026-10-25-m2-fee-overflow-compare.json`  
**Prior summary:** `2026-10-25-m2-fee-overflow-diagnosis.md`  
**WebAuthn (Csaba):** `2026-10-25-m2-passkey-create-ok-get-focus-fail.md` — create OK, binding `get` lost focus; explicit Bind wallet fix owned by Csaba.

---

## 1. Measured fee findings (deposit vs `create_payout`)

Samples across **3 consecutive ledgers** (~5384960–5384964); values **stable within the window**.

| Metric | Source | `deposit` | `create_payout` |
|--------|--------|-----------|-----------------|
| minResourceFee | **RPC** `simulate` | **13 442** | **2 910 966 914** |
| resourceFee | **XDR** Soroban tx data | 13 442 | 2 910 966 914 |
| Assembled `built.fee` | **SDK** after Client assemble | 13 542 | 2 910 967 014 |
| instructions | **XDR** resources | 899 733 | 991 206 |
| diskReadBytes | **XDR** | 116 | **0** |
| writeBytes | **XDR** | 488 | 1 176 |
| footprint RO / RW | **XDR** | 3 / 3 | 1 / 4 |
| events count / ~bytes | **RPC** / estimate | 5 / ~7.4KB | 3 / ~6.7KB |
| return value ~bytes | estimate from retval XDR | 4 | 12 |
| stateChanges | **RPC** | 3× `updated` | 2× `updated` + **2× `created`** |
| restorePreamble | **RPC** | none | none |

**Interpretation (evidence-backed, not invented fee math):**  
Compute/bandwidth footprint for `create_payout` is similar order to `deposit`, but **RPC `minResourceFee` is ~200 000× higher**. That points to **rent / state-creation cost** inside the RPC-returned fee (two `created` stateChanges), not instruction count.  

**API overflow total `5261104576`:** recorded only as the API error string. This script’s AssembledTransaction `built.fee` is ~2.91e9 (fits uint32). **Exact decomposition of 5.26e9 into RPC components is unavailable** from fields we have — do not invent restore/addend parts without a matching RPC/SDK field.

**Network ConfigSetting (RPC `getLedgerEntries`, ledgerCost arm):** includes `sorobanStateRentFeeGrowthFactor = 5000` plus ledger/tx write caps. Full rent-fee schedule tables were not expanded as numeric accessors beyond this arm’s simple counters.

Across the day, successful lock `fee_charged` on Horizon rose ~1.19e9 → 1.47e9 → 1.80e9 before overflow blocked submit.

---

## 2. API vs diagnostic construction (do not assume identical inputs)

| Aspect | API `fundAndRun` → `fundVault` + `lock` | This diagnostic script |
|--------|----------------------------------------|-------------------------|
| Contract / vault | `FP_PAYOUT_VAULT_ID` baseline | same |
| Invoker | `vaultPayer` demo payer | same address |
| Methods | `deposit` then `create_payout` | same method names, **independent** sims |
| Amount / mode | settle `amountIn` + quoted fee, `PayerPays` | same minor amounts used for failed M2 pays |
| `external_id` | `sha256(paymentId:lockAttempt)` | same formula for `pay_b61…:1` |
| `claim_hash` | from **sealed claim secret** | **random 32-byte placeholder** |
| `expires_at` | runtime `lockExpiresAt` | **now+3600** |
| Fee path | Client invoke + **`signAndSend`** (re-sim/assemble possible) | Client invoke only — **no `signAndSend`** |

Therefore: pathological **RPC minResourceFee** is real for `create_payout` under this vault/state, but the API’s **5.26e9** total must not be assumed to share identical args or assemble steps with the script’s **2.91e9** built fee.

---

## 3. `run.ts` replay / duplicate-funding risk

From `executeSettle` (`apps/api/src/orchestrator/run.ts`):

1. If `leg.externalRef` set → resume only (**skips `fundVault`**).  
2. Else `findLock(payer, paymentId, lockAttempt)` → if found, persist ref and resume (**skips deposit**).  
3. Else **`lockAttempt += 1`**, `findLock` for new attempt, then **always** `fundVault` then `lock`.

**DB on failed fee-overflow payments (local M2 accept DB):**

| paymentId | status | lockAttempt | externalRef | lockTxRef |
|-----------|--------|-------------|-------------|-----------|
| `pay_b61ffbac…` | processing | **3** | **null** | null |
| `pay_a2549b83…` | processing | **1** | **null** | null |

`payoutByExternal` for those IDs was **null** (no on-chain payout). Horizon showed **successful low-fee invokes** during failed `/fund` windows → deposits landed.

**Conclusion:** Existing vault balance does **not** make replay skip `fundVault`. For these failed payments, **re-calling `/fund` will bump attempt and deposit again** (duplicate-funding risk). Skip only happens after a durable `externalRef` or successful `findLock` recovery.

---

## 4. Anchor vault #2

Unchanged: `create_payout` sim → Contract **#5 InsufficientBalance** (payer vault balance 0). Does **not** exercise the overflow lock path. No funding authorised.

---

## 5. Smallest evidence-backed recommendation

1. Investigate **why RPC assigns ~2.9e9 minResourceFee** to baseline `create_payout` despite modest instructions/writeBytes — rent on `created` entries / TTL is still the leading hypothesis; **do not treat `sorobanStateRentFeeGrowthFactor=5000` as a direct multiplier** (it only affects post-target `fee_per_rent_1kb` slope). Follow-up: `2026-10-25-m2-fee-rent-matched.md`.  
2. Separately explain API **5.26e9** vs script **2.91e9** with **matched args** and **`sign()` rebuild inspection** — without inventing fee components. **Update:** speculative additive split in the diagnosis note is **corrected/retired** in Assignment 1 evidence.  
3. **Do not** re-`/fund` failed payments without Claude review; code **will re-deposit**. Prefer withdraw/reconcile stranded balance or a Claude-designed lock-only path after `findLock`/balance checks.  
4. No fee cap/truncation, no vault redeploy, no claim replacement from this lane.

**M2:** NOT VERIFIED · **Freebuff / other acceptance:** paused · **Payer:** unlocked.
