-- Bonus votes for paying to the jar; the 10-vote pack is sold only for money
ALTER TABLE "VotePackage" ADD COLUMN "bonusCard" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "starsEnabled" BOOLEAN NOT NULL DEFAULT true;

UPDATE "VotePackage" SET "starsEnabled" = false WHERE "votes" = 10;
UPDATE "VotePackage" SET "bonusCard" = 1 WHERE "votes" = 10;
UPDATE "VotePackage" SET "bonusCard" = 3 WHERE "votes" = 20;
UPDATE "VotePackage" SET "bonusCard" = 10 WHERE "votes" = 50;
UPDATE "VotePackage" SET "bonusCard" = 25 WHERE "votes" = 100;
