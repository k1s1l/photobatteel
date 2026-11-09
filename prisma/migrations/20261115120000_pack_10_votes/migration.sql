-- The smallest pack: 10 votes for 10 UAH (was 5 votes). The Stars price keeps the same price per vote.
UPDATE "VotePackage" SET "votes" = 10, "priceStars" = "priceStars" * 2 WHERE "votes" = 5;
