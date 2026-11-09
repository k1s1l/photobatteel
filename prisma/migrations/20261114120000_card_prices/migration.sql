-- Card prices of the standard packs: 10 / 20 / 50 UAH (Monobank jars accept transfers from 10 UAH)
UPDATE "VotePackage" SET "priceCard" = 1000 WHERE "votes" = 5;
UPDATE "VotePackage" SET "priceCard" = 2000 WHERE "votes" = 20;
UPDATE "VotePackage" SET "priceCard" = 5000 WHERE "votes" = 50;
