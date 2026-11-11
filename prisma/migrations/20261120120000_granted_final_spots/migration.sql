-- Places in the final given by an admin (no payment)
ALTER TABLE "FinalSpot" ADD COLUMN "grantedById" INTEGER,
ALTER COLUMN "paymentId" DROP NOT NULL;
