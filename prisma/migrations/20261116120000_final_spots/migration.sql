-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "finalSpotBattleId" INTEGER;

-- CreateTable
CREATE TABLE "FinalSpot" (
    "id" SERIAL NOT NULL,
    "battleId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "photoId" INTEGER,
    "usedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinalSpot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinalSpot_paymentId_key" ON "FinalSpot"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "FinalSpot_photoId_key" ON "FinalSpot"("photoId");

-- CreateIndex
CREATE INDEX "FinalSpot_battleId_idx" ON "FinalSpot"("battleId");

-- CreateIndex
CREATE UNIQUE INDEX "FinalSpot_battleId_userId_key" ON "FinalSpot"("battleId", "userId");

-- AddForeignKey
ALTER TABLE "FinalSpot" ADD CONSTRAINT "FinalSpot_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSpot" ADD CONSTRAINT "FinalSpot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSpot" ADD CONSTRAINT "FinalSpot_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinalSpot" ADD CONSTRAINT "FinalSpot_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

