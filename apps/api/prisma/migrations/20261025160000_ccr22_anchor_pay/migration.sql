-- CCR-22 review: withdraw concurrency reservation + classic /pay persist-before-send
-- + separate anchorStellarTransactionId vs anchorPaymentTxHash.

ALTER TABLE "ClaimLink" ADD COLUMN "anchorSessionStatus" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorStellarTransactionId" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayPendingTxHash" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayPendingSealed" BYTEA;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayPendingSealedNonce" BYTEA;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayMinTime" INTEGER;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayMaxTime" INTEGER;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPayStatus" TEXT;

CREATE INDEX "ClaimLink_anchorPayPendingTxHash_idx" ON "ClaimLink"("anchorPayPendingTxHash");
