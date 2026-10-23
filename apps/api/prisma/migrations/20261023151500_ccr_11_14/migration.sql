-- CCR-11 claim seal, CCR-12 settle tx refs, CCR-13 quote feeMode

ALTER TABLE "Quote" ADD COLUMN "feeMode" TEXT;

ALTER TABLE "Leg" ADD COLUMN "lockTxRef" TEXT;
ALTER TABLE "Leg" ADD COLUMN "releaseTxRef" TEXT;

ALTER TABLE "ClaimLink" ADD COLUMN "vaultClaimHashHex" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "secretSealed" BYTEA;
ALTER TABLE "ClaimLink" ADD COLUMN "secretSealedNonce" BYTEA;
