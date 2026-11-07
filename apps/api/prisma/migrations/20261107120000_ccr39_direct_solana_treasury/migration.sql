-- CCR-39: direct Solana settle to FlexiPay treasury (reference + intent age on Payment).
ALTER TABLE "Payment" ADD COLUMN "solanaPayReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "solanaIntentAt" TIMESTAMP(3);
