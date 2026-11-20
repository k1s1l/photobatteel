-- 50 UAH -> 60 votes, 100 UAH -> 120 votes
UPDATE "VotePackage" SET "bonusCard" = 10 WHERE "votes" = 50;
UPDATE "VotePackage" SET "bonusCard" = 20 WHERE "votes" = 100;
