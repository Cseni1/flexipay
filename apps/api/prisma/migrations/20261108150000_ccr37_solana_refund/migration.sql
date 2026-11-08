-- CCR-37: durable treasury refunds for a Solana settle that ends in refund.
ALTER TABLE "Payment" ADD COLUMN "solanaPayer" TEXT;
ALTER TABLE "Payment" ADD COLUMN "solanaSettleMint" TEXT;
ALTER TABLE "Payment" ADD COLUMN "solanaSettleAmount" TEXT;
ALTER TABLE "Payment" ADD COLUMN "solanaSettleDecimals" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "solanaSettleDestination" TEXT;

CREATE TABLE "SolanaRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "amountValue" TEXT NOT NULL,
    "treasury" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "signature" TEXT,
    "signedTx" TEXT,
    "lastValidBlockHeight" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "SolanaRefund_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SolanaRefund_paymentId_key" ON "SolanaRefund"("paymentId");
CREATE UNIQUE INDEX "SolanaRefund_signature_key" ON "SolanaRefund"("signature");
CREATE INDEX "SolanaRefund_status_idx" ON "SolanaRefund"("status");

ALTER TABLE "SolanaRefund" ADD CONSTRAINT "SolanaRefund_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
