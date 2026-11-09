-- CCR-51: a Due payout funded from the sender's own Solana wallet. The Due transfer id stays on
-- the payout leg (externalRef). All columns nullable; existing rows stay unchanged.
ALTER TABLE "Payment" ADD COLUMN "dueSenderWallet" TEXT;
ALTER TABLE "Payment" ADD COLUMN "dueFundingAddress" TEXT;
ALTER TABLE "Payment" ADD COLUMN "dueFundingAmount" TEXT;
ALTER TABLE "Payment" ADD COLUMN "dueFundingExpiresAt" TIMESTAMP(3);
