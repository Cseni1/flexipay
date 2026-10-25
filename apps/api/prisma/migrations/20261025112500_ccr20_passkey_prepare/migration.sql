-- CCR-20 (ELFOGADÁSRA VÁR): PasskeyClaimPrepare for M2 passkey claim flow.
-- Do not treat as accepted until docs/CONTRACT_CHANGES.md CCR-20 is ACK'd.

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
    "submitIdempotencyKeyHash" TEXT,
    "pendingTxHash" TEXT,
    "pendingTxSealed" BYTEA,
    "pendingTxSealedNonce" BYTEA,
    "releaseTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasskeyClaimPrepare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasskeyClaimPrepare_submitIdempotencyKeyHash_key" ON "PasskeyClaimPrepare"("submitIdempotencyKeyHash");

CREATE INDEX "PasskeyClaimPrepare_paymentId_status_idx" ON "PasskeyClaimPrepare"("paymentId", "status");

CREATE INDEX "PasskeyClaimPrepare_tokenHash_idx" ON "PasskeyClaimPrepare"("tokenHash");

CREATE INDEX "PasskeyClaimPrepare_pendingTxHash_idx" ON "PasskeyClaimPrepare"("pendingTxHash");

ALTER TABLE "PasskeyClaimPrepare" ADD CONSTRAINT "PasskeyClaimPrepare_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
