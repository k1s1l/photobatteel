-- Vote buttons one per row under a short buttons text
ALTER TABLE "Duel" ADD COLUMN "stackedButtons" BOOLEAN NOT NULL DEFAULT false;
