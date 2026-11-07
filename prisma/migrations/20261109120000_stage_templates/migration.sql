-- Per-round post designs (round 1..5, semifinal, final)
ALTER TABLE "BotSettings" ADD COLUMN "stageTemplates" JSONB NOT NULL DEFAULT '{}';
