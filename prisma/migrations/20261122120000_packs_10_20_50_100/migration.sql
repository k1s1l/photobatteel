-- Vote packs 10 / 20 / 50 / 100: the same number of hryvnias and Stars as votes
UPDATE "VotePackage" SET "priceStars" = "votes", "priceCard" = "votes" * 100 WHERE "votes" IN (10, 20, 50);

INSERT INTO "VotePackage" ("votes", "priceStars", "priceCard", "isActive", "sortOrder", "updatedAt")
SELECT 100, 100, 10000, true, 4, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "VotePackage")
  AND NOT EXISTS (SELECT 1 FROM "VotePackage" WHERE "votes" = 100);
