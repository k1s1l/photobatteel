-- The bot can publish posts in the channel itself
ALTER TABLE "BotSettings" ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false;
