# Deposit recovery migration plan (CCR-23)

**Status:** ELFOGADÁSRA VÁR — plan only. Do **not** apply this migration until CCR-23 is accepted.  
**Base:** `origin/main` @ plan PR head.  
**Out of scope here:** runtime code, `prisma migrate deploy` on shared DBs, funding / deposit / lock / release / `/pay`, SDK fee-fix duplication, replay of `pay_b61…` / `pay_a254…`.

## Goal

Make a successful vault **deposit** durable on the settle leg **before** lock, so fund replay cannot create a second deposit, and so one on-chain deposit cannot bind to two payments.

## Mapping (no rename of collect/settle)

Funding is executed inside settle orchestration today (`executeSettle` → `fundVault` then `lock`). There is no separate `fund` leg kind.

| Concern | Existing | CCR-23 addition |
|---|---|---|
| Vault payout id | `Leg.externalRef` (CCR-12) | unchanged |
| Lock tx | `Leg.lockTxRef` | unchanged |
| Release / refund tx | `Leg.releaseTxRef` | unchanged |
| Lock attempt | `Payment.lockAttempt` (CCR-15) | unchanged semantics; bump rules tightened in CCR-23 |
| Provider attempt | `Leg.attempt` (CCR-14) | unchanged |
| **Deposit tx** | *(discarded today)* | **new** settle-leg columns below |

Do **not** overload `lockTxRef` / `externalRef` / collect fields for deposits.

## Proposed Prisma columns (`Leg`)

All nullable. Meaningful only when `kind = "settle"` and a deposit has been confirmed.

| Column | Type | Notes |
|---|---|---|
| `fundTxRef` | `String?` | `SettlementRef.txRef` from successful `fundVault` |
| `fundOpIndex` | `Int?` | 0-based op index of the verified `deposit` invoke |
| `fundAmountValue` | `String?` | minor units, integer string |
| `fundAmountCurrency` | `String?` | e.g. `USDC` |
| `fundNetwork` | `String?` | `stellar` \| `mock` |
| `fundVaultId` | `String?` | vault contract / mock id |

### Unique / index

```text
@@unique([fundNetwork, fundVaultId, fundTxRef, fundOpIndex])
```

PostgreSQL **partial** unique index so rows without a confirmed deposit stay unconstrained:

```sql
CREATE UNIQUE INDEX "Leg_fund_deposit_identity_key"
ON "Leg" ("fundNetwork", "fundVaultId", "fundTxRef", "fundOpIndex")
WHERE "fundTxRef" IS NOT NULL;
```

Optional non-unique index for ops lookup: `(fundTxRef)` WHERE NOT NULL.

No new FK: identity is on-chain scoped, not a second payment relation. `Leg.paymentId` remains the only payment FK.

### Deposit identity

`(fundNetwork, fundVaultId, fundTxRef, fundOpIndex)` — see CCR-23 §3.  
Hash alone is insufficient when a transaction may contain multiple operations.

## Existing rows

| Case | Treatment |
|---|---|
| Settle legs with null fund columns | Leave null — **not** confirmed |
| Payments that already have `externalRef` / `lockTxRef` but null fund columns | Leave fund columns null unless ops reconcile binds a verified deposit; do **not** infer confirm from lock success alone in v1 (lock implies a prior deposit economically, but CCR-23 confirm is explicit receipt/reconcile) |
| Stranded on-chain deposits with no DB row | Ops `POST /v1/ops/deposits/reconcile` only; never auto-scan-and-confirm in migration |
| `pay_b61…` / `pay_a254…` style failures | **No** migration backfill; **no** live replay from this plan |

**Forbidden backfill:** `UPDATE Leg SET fundTxRef = …` from guesses, Horizon scrapes without decode verification, or “balance looks funded”.

## Safe apply (after ACK)

1. Integrator accepts CCR-23.
2. Add Prisma model fields + generate migration SQL matching the partial unique index above (implement PR — not this plan PR).
3. Apply on **disposable / local** DB first; run targeted tests listed in CCR-23 §7.
4. Shared/staging DB: migrate in a maintenance window; confirm `Leg` row counts unchanged; spot-check null fund columns remain null for historical settles.
5. Deploy API build that **writes** fund columns and enforces replay/unique rules only after migrate succeeds (expand/contract: nullable columns first is already expand-safe).

## Safe rollback (no payment data loss)

1. Deploy API build that **ignores** fund columns (or treats them optional) if a hotfix is required — columns remain nullable.
2. `DROP INDEX IF EXISTS "Leg_fund_deposit_identity_key";`
3. `ALTER TABLE "Leg" DROP COLUMN IF EXISTS ...` for the six fund columns.
4. Payment / lock / release history (`externalRef`, `lockTxRef`, `releaseTxRef`, `lockAttempt`) untouched.

Rollback does **not** delete Events/AuditRows. It only removes the deposit-confirm columns/index.

## Verification checklist (post-apply, still no live acceptance in plan phase)

- `\d "Leg"` shows new columns nullable.
- Partial unique index present; inserting two legs with the same four-tuple fails.
- Inserting many legs with all fund columns null succeeds.
- No row automatically gained a non-null `fundTxRef` solely from migrate.

## Related files (implementation later — not modified in this plan PR)

- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/<timestamp>_ccr23_deposit_recovery/`
- `apps/api/src/orchestrator/run.ts` (`executeSettle`)
- `apps/api/src/routes/` (ops reconcile)
- `packages/domain/src/adapters.ts` + API zod for ops + `resource_fee_ceiling`
- `packages/adapter-stellar/` (decode/map only; no SDK fee-fix fork)
- `apps/api/test/` + orchestrator tests for CCR-23 §7
