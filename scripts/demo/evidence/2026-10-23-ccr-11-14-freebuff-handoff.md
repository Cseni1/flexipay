# Freebuff evidence handoff — CCR-11–14 (23 Oct 2026)

**From:** integrator (Cursor)  
**To:** Freebuff acceptance lane (`csenge-freebuff/*`)  
**Main tip:** `b3d77a7` (`Merge #36` CCR-11–14). Prior reported tip `0f7ca41` / `557310e` obsolete.  
**Do not edit** active acceptance scripts (`df1`–`df5`, `run-all.ts`) for this handoff — use this file as the contract/evidence brief only.

## What landed (contracts only)

| CCR | On main | Acceptance implication |
| --- | --- | --- |
| **11** | `ClaimLink.vaultClaimHashHex` + sealed secret cols; `FP_CLAIM_SEAL_KEY` | DF3 / claim-after-restart needs CC2 seal implement + CC3 accept. Process `Map` on #32 is **not** sufficient. |
| **12** | `Leg.lockTxRef` / `releaseTxRef`; settle `externalRef` = **payoutId** only | Horizon proofs use `releaseTxRef`; never treat payoutId as a tx hash; never require secrets. |
| **13** | PlannedLeg `amountIn`/`amountOut`; `fees.settleUnlockedRemainder`; Quote `feeMode` | Prove lock uses quoted **P** + feeMode. Adapter testnet: **P=1 USDC** net + **f(P)=0.01** fee → lock debit **1.01**, not a 1 USDC all-in budget. See `2026-10-23-sc2-adapter-testnet.md`. |
| **14** | One payout retry under `processing` + durable `Leg.attempt` | Evidence must show attempt 1 → 2, then refund; **no** attempt 3. |

## Stellar adapter (lane-B) — read-only result

`@flexipay/adapter-stellar` on `b3d77a7` already matches the settlement interface: distinct `payoutId` + `txRef`, `lock(amount=P, feeMode)`, `findLock(paymentId, attempt)`. **No adapter change required** for CCR-11–14. Persistence of seal + tx refs is API/CC2.

## Open PRs (do not treat as acceptance PASS)

| PR | Head | Label | Blocker for Freebuff |
| --- | --- | --- | --- |
| **#32** CC2 | `c7e1bf1` | DRAFT / PARTIAL | Not rebased to `b3d77a7`; Map secrets; no lock/release tx cols; fundVault fee-mode defect; create-from-quote missing. Defects posted on PR. |
| **#37** CF4 | `862419b` | DRAFT | Claim UI only; claim API routes not on main → integrated DF3 **NOT RUN**. |
| **#29** CF1 | `dad7731` | DRAFT | Send/detail UI; still behind claim/orchestrator stack. |

## Still OPEN acceptance points

- Quote → lock money conservation (both fee modes + rounding)
- Claim release after API restart
- Required failure/refund paths + exactly one retry
- DF5 recipient-kind exclusion explanation
- Integrated DF3 vault release to intended recipient

## Suggested Freebuff next (when CC2/CC3 land)

1. Rebase acceptance worktree to latest `main`.
2. After CC2 persists seal + tx refs and CC3 mounts claim routes: run DF3 with restart between lock and claim; assert Horizon on `releaseTxRef` and net **P** (not P+fee) to recipient.
3. DF4: one retry then refund; prove `Leg.attempt` never reaches 3.
4. Leave web claim UX to Csaba Freebuff (#37); do not duplicate.

## Checks this review turn

- Reviewed #32 tree read-only vs contracts (no CC2 code edits).
- Adapter settlement surface read-only — compatible; no lane-B PR.
- No blocked DF*/testnet re-runs (no relevant CC2/CC3 change yet).
