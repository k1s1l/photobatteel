-- Paying to the jar gives +10% votes (100 UAH -> +10)
UPDATE "VotePackage" SET "bonusCard" = "votes" / 10;
