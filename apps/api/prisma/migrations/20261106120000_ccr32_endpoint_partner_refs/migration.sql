-- CCR-32: partner-created ids persisted on an endpoint (Tazapay beneficiary), and the
-- destination endpoint a batch payment was created for.
ALTER TABLE "Endpoint" ADD COLUMN "partnerRefs" JSONB;
ALTER TABLE "Payment" ADD COLUMN "endpointId" TEXT;
CREATE INDEX "Payment_endpointId_idx" ON "Payment"("endpointId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
