-- CCR-20 (ELFOGADÁSRA VÁR): passkey prepare + claim-bound deploy recovery.
-- Do not treat as accepted until docs/CONTRACT_CHANGES.md CCR-20 is ACK'd.
-- Release success remains Leg.releaseTxRef (CCR-12); no prepare.releaseTxHash.

-- ClaimLink: durable deploy binding (contractId + pending tx BEFORE send).
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyContractId" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyDeployTxHash" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyDeployPendingContractId" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyDeployPendingTxHash" TEXT;
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyDeployPendingSealed" BYTEA;
ALTER TABLE "ClaimLink" ADD COLUMN "passkeyDeployPendingSealedNonce" BYTEA;

CREATE INDEX "ClaimLink_passkeyDeployPendingTxHash_idx" ON "ClaimLink"("passkeyDeployPendingTxHash");
CREATE INDEX "ClaimLink_passkeyDeployTxHash_idx" ON "ClaimLink"("passkeyDeployTxHash");

CREATE TABLE "PasskeyClaimPrepare" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "networkPassphrase" TEXT NOT NULL,
    "signatureExpirationLedger" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "authInvocationFingerprints" JSONB NOT NULL,
    "authNonces" JSONB NOT NULL,
    "authAddresses" JSONB NOT NULL,
    "authEntriesSealed" BYTEA NOT NULL,
    "authEntriesSealedNonce" BYTEA NOT NULL,
    "reservedAt" TIMESTAMP(3),
    "pendingTxHash" TEXT,
    "pendingTxSealed" BYTEA,
    "pendingTxSealedNonce" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasskeyClaimPrepare_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasskeyClaimPrepare_paymentId_status_idx" ON "PasskeyClaimPrepare"("paymentId", "status");

CREATE INDEX "PasskeyClaimPrepare_tokenHash_idx" ON "PasskeyClaimPrepare"("tokenHash");

CREATE INDEX "PasskeyClaimPrepare_pendingTxHash_idx" ON "PasskeyClaimPrepare"("pendingTxHash");

ALTER TABLE "PasskeyClaimPrepare" ADD CONSTRAINT "PasskeyClaimPrepare_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
