-- CCR-23: durable confirmed vault deposit on settle legs (nullable; no backfill).
ALTER TABLE "Leg" ADD COLUMN "fundTxRef" TEXT;
ALTER TABLE "Leg" ADD COLUMN "fundOpIndex" INTEGER;
ALTER TABLE "Leg" ADD COLUMN "fundAmountValue" TEXT;
ALTER TABLE "Leg" ADD COLUMN "fundAmountCurrency" TEXT;
ALTER TABLE "Leg" ADD COLUMN "fundNetwork" TEXT;
ALTER TABLE "Leg" ADD COLUMN "fundVaultId" TEXT;

-- One deposit identity to one payment (global). Null fundTxRef rows stay unconstrained.
CREATE UNIQUE INDEX "Leg_fund_deposit_identity_key"
ON "Leg" ("fundNetwork", "fundVaultId", "fundTxRef", "fundOpIndex")
WHERE "fundTxRef" IS NOT NULL;

CREATE INDEX "Leg_fundTxRef_idx" ON "Leg"("fundTxRef");
