-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('STARS', 'CARD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityAction" ADD VALUE 'PAYMENT_SUCCEEDED';
ALTER TYPE "ActivityAction" ADD VALUE 'PAYMENT_REFUNDED';
ALTER TYPE "ActivityAction" ADD VALUE 'PAID_VOTES_SPENT';
ALTER TYPE "ActivityAction" ADD VALUE 'PACKAGE_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE 'LANGUAGE_CHANGED';

-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN     "paidVotesEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "paidVotes" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "voteBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VotePackage" (
    "id" SERIAL NOT NULL,
    "votes" INTEGER NOT NULL,
    "priceStars" INTEGER NOT NULL,
    "priceCard" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VotePackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "packageId" INTEGER,
    "votes" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "targetPhotoId" INTEGER,
    "telegramChargeId" TEXT,
    "providerChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaidVote" (
    "id" SERIAL NOT NULL,
    "photoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "paymentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaidVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_telegramChargeId_key" ON "Payment"("telegramChargeId");

-- CreateIndex
CREATE INDEX "Payment_status_paidAt_idx" ON "Payment"("status", "paidAt");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaidVote_photoId_idx" ON "PaidVote"("photoId");

-- CreateIndex
CREATE INDEX "PaidVote_userId_createdAt_idx" ON "PaidVote"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "VotePackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_targetPhotoId_fkey" FOREIGN KEY ("targetPhotoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaidVote" ADD CONSTRAINT "PaidVote_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaidVote" ADD CONSTRAINT "PaidVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
