-- CCR-45: BlindPay customer on the individual sender, and the short-lived payout quote
-- on a sender-wallet payment. All columns nullable; existing rows stay unchanged.
ALTER TABLE "Organization" ADD COLUMN "blindpayCustomerId" TEXT;
ALTER TABLE "Organization" ADD COLUMN "blindpayKycStatus" TEXT;
ALTER TABLE "Organization" ADD COLUMN "blindpayTosId" TEXT;

ALTER TABLE "Payment" ADD COLUMN "blindpayQuoteId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "blindpayQuoteExpiresAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "blindpaySenderWallet" TEXT;
