-- Places in the final: managed from the admin panel
ALTER TABLE "BotSettings" ADD COLUMN "finalSpotsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "finalSpotCount" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "finalSpotPrice" INTEGER NOT NULL DEFAULT 25;
