-- Lane B (CCR-24 amendments, proposed): Solana claim binding + Pay reference + unique release evidence.

ALTER TABLE "ClaimLink" ADD COLUMN "acceptedEndpointId" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "solanaPayReference" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "solanaIntentAt" TIMESTAMP(3);

CREATE INDEX "ClaimLink_acceptedEndpointId_idx" ON "ClaimLink"("acceptedEndpointId");

-- One settle release signature / tx hash may mark at most one payment paid.
CREATE UNIQUE INDEX "Leg_releaseTxRef_key"
ON "Leg" ("releaseTxRef")
WHERE "releaseTxRef" IS NOT NULL;
