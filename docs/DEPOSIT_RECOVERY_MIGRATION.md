# Deposit recovery migration plan (CCR-23)

**Status:** ELFOGADVA (amended) with CCR-23 — plan only in PR #76.  
**Do not apply** this migration in this docs PR. Runtime / Prisma SQL / CLI implementation waits for **#76 merge by Claude**, then a **separate** implement PR.  
**Out of scope here:** runtime code, `prisma migrate deploy`, shared-DB writes, backup execution, funding / deposit / lock / release / `/pay`, SDK fee-fix duplication, replay of `pay_b61…` / `pay_a254…`.  
**Withdrawn:** HTTP ops reconcile route, `FP_OPS_ORG_IDS`, invented `resource_fee_ceiling` domain code, assumed `fundOpIndex = 0`, calling drop of populated fund columns “data-loss-free”.

## Goal

Make a successful vault **deposit** durable on the settle leg **before** lock, so fund replay cannot create a second deposit, and so one on-chain deposit cannot bind to two payments.

## Mapping (no rename of collect/settle)

Funding runs inside settle orchestration today (`executeSettle` → `fundVault` then `lock`). There is no separate `fund` leg kind.

| Concern | Existing | CCR-23 addition |
|---|---|---|
| Vault payout id | `Leg.externalRef` (CCR-12) | unchanged |
| Lock tx | `Leg.lockTxRef` | unchanged |
| Release / refund tx | `Leg.releaseTxRef` | unchanged |
| Lock attempt | `Payment.lockAttempt` (CCR-15) | same counter; bump only after verified refunded/cancelled + CAS + audit |
| Provider attempt | `Leg.attempt` (CCR-14) | unchanged |
| **Deposit tx** | *(discarded today)* | **new** settle-leg columns below |

Do **not** overload `lockTxRef` / `externalRef` / collect fields for deposits.

## Proposed Prisma columns (`Leg`)

All nullable. Meaningful only when `kind = "settle"` and a deposit has been confirmed.

| Column | Type | Notes |
|---|---|---|
| `fundTxRef` | `String?` | `SettlementRef.txRef` from successful `fundVault` |
| `fundOpIndex` | `Int?` | From **on-chain/mock decode** of the matching `deposit` invoke — never presumed `0` |
| `fundAmountValue` | `String?` | minor units, integer string |
| `fundAmountCurrency` | `String?` | e.g. `USDC` |
| `fundNetwork` | `String?` | `stellar` \| `mock` |
| `fundVaultId` | `String?` | vault contract / mock id |

### Unique / index (partial)

```sql
CREATE UNIQUE INDEX "Leg_fund_deposit_identity_key"
ON "Leg" ("fundNetwork", "fundVaultId", "fundTxRef", "fundOpIndex")
WHERE "fundTxRef" IS NOT NULL;
```

Optional non-unique index for CLI lookup: `(fundTxRef)` WHERE NOT NULL.

No new FK beyond `Leg.paymentId`. Identity is chain-scoped.

### Deposit identity

`(fundNetwork, fundVaultId, fundTxRef, fundOpIndex)` — CCR-23 §3.  
Decode must identify **exactly one** matching vault deposit; multiple matching deposit invokes → reject bind/confirm. Hash alone is insufficient.

## Existing rows / backfill

| Case | Treatment |
|---|---|
| Settle legs with null fund columns | Leave null — **not** confirmed |
| Legs with lock refs but null fund columns | Leave null unless operator **local CLI** reconcile binds a verified deposit |
| Stranded on-chain deposits | Local CLI reconcile only (lock + CAS + audit); never auto-scan in migration |
| `pay_b61…` / `pay_a254…` style failures | **No** migration backfill; **no** live replay from this plan |

**Forbidden:** invented confirmed backfill (`UPDATE … fundTxRef = …` from guesses, unverified Horizon scrapes, or “balance looks funded”).

## Prerequisites before apply (shared / stranded DBs)

1. CCR-23 accepted (this amendment) and #76 merged.
2. Implement PR reviewed; migration SQL matches the partial unique index above.
3. **Mandatory backup** before migrating any database that may hold stranded payments or recovery-relevant settle state (at minimum a restorable PostgreSQL dump / snapshot covering `Payment`, `Leg`, `Event`, `AuditRow`, related claim tables as deployed). Record backup id/location in the change ticket.
4. Prefer disposable/local apply + CCR-23 §8 tests before shared/staging.

Without a verified restore path for that backup, **do not** migrate a stranded-payment DB.

## Safe apply (after #76 merge + implement PR)

1. Confirm backup restore drill (or documented restore procedure) for the target DB.
2. Apply migration (nullable columns + partial unique index).
3. Verify row counts unchanged; all historical `fundTxRef` remain null unless explicitly out of scope.
4. Deploy API/CLI that writes fund columns and enforces replay / unique / CAS rules only after migrate succeeds.

## Rollback and restore (recovery data preserved)

Populated `fund*` columns **are recovery data**. Dropping them after confirm/reconcile has written values is **data loss** for deposit identity — do **not** describe that as data-loss-free.

### Prefer: restore from pre-migrate backup

1. Stop writers that depend on CCR-23 fund columns (or deploy a build that does not require them only if columns are still all-null — see below).
2. Restore the **pre-migration backup** taken in Prerequisites.
3. Verify `Payment` / `Leg` / `Event` / `AuditRow` (and claim tables) match expected counts; spot-check stranded payment ids still present.
4. Only then re-attempt migrate on a fresh backup cycle.

### Schema-only rollback when fund columns are still all null

If **and only if** every `Leg.fundTxRef` is still `NULL` (no confirms/reconciles written):

1. Deploy API build that does not read/write fund columns.
2. `DROP INDEX IF EXISTS "Leg_fund_deposit_identity_key";`
3. `ALTER TABLE "Leg" DROP COLUMN` for the six fund columns.
4. CCR-12 lock/release fields and `lockAttempt` remain.

### If any fund column is populated

- **Do not** drop fund columns as a “safe” rollback.
- Roll forward (fix forward) or **restore from backup** taken before migrate / before the writes that populated them.
- Operator CLI reconcile history in `AuditRow` / `Event` must remain consistent with restored Leg state — do not delete audit to “clean” a partial rollback.

## Verification checklist (post-apply; still no live acceptance in the docs PR)

- `\d "Leg"` shows new columns nullable.
- Partial unique index present; duplicate four-tuple insert fails.
- Many null-fund legs insert successfully.
- No row gained non-null `fundTxRef` from migrate alone.
- Backup id and restore procedure recorded for stranded DBs.

## Fee ceiling (runtime env — not a migration default)

- Required for vault writes after the SDK fee handoff lands: `FP_SOROBAN_TX_FEE_CEILING_STROOPS`.
- **No** committed default; **no** migration/seed value. Local testnet example `20000000` is runtime-env only.
- Typed errors: `VaultTxFeeError` / `VaultTxFeeRejectReason` from `packages/adapter-stellar/src/vault-tx-fee.ts` on `event/csenge-cursor/sdk-fee-build` (see CCR-23 §6). Not yet on `main` at amendment time.

## Related files (implementation later — not modified in #76)

- `apps/api/prisma/schema.prisma` + migration folder
- `apps/api/src/orchestrator/run.ts` (`executeSettle`)
- Local operator reconcile CLI under `scripts/` (not HTTP ops)
- `packages/adapter-stellar/` fee handoff consume + deposit decode
- Orchestrator / CLI tests for CCR-23 §8
