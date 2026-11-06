-- Payments by transfer to the owner's card / Monobank jar.
ALTER TYPE "PaymentMethod" ADD VALUE 'TRANSFER';
ALTER TYPE "PaymentStatus" ADD VALUE 'CLAIMED' AFTER 'PENDING';
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "ActivityAction" ADD VALUE 'PAYMENT_CANCELLED' AFTER 'PAYMENT_REFUNDED';

ALTER TABLE "Payment" ADD COLUMN "code" TEXT,
ADD COLUMN "bankTransactionId" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "reviewRequestedAt" TIMESTAMP(3),
ADD COLUMN "confirmedById" INTEGER;
CREATE UNIQUE INDEX "Payment_code_key" ON "Payment"("code");
CREATE UNIQUE INDEX "Payment_bankTransactionId_key" ON "Payment"("bankTransactionId");
CREATE INDEX "Payment_method_status_idx" ON "Payment"("method", "status");

ALTER TABLE "BotSettings" ADD COLUMN "transferEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "transferDetails" TEXT,
ADD COLUMN "monobankAccountId" TEXT;
