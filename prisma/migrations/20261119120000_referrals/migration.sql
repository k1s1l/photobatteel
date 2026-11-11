-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referralCountedAt" TIMESTAMP(3),
ADD COLUMN     "referralRewards" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referralsCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referredById" INTEGER;
-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
