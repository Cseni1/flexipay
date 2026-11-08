-- CCR-43: optional recipient postal address for partner payouts (nullable, additive).
ALTER TABLE "Recipient" ADD COLUMN "addressLine1" TEXT;
ALTER TABLE "Recipient" ADD COLUMN "addressLine2" TEXT;
ALTER TABLE "Recipient" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "Recipient" ADD COLUMN "addressState" TEXT;
ALTER TABLE "Recipient" ADD COLUMN "addressPostalCode" TEXT;
