-- CCR-22: claim-link reference-anchor withdraw binding (M1).
-- Three refs: Leg.releaseTxRef (vault), ClaimLink.anchorTxId (SEP-24),
-- ClaimLink.anchorPaymentTxHash (classic/anchor payment) — kept separate.

ALTER TABLE "ClaimLink" ADD COLUMN "recipientClassicAddress" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorTxId" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorUrlSanitised" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorWithdrawAmount" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "anchorPaymentTxHash" TEXT;

CREATE UNIQUE INDEX "ClaimLink_anchorTxId_key" ON "ClaimLink"("anchorTxId");
