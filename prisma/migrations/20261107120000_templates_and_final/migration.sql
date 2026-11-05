-- Designs for every prepared post, a separate final duration, publication reminders.
ALTER TABLE "BotSettings" ADD COLUMN "announceTemplate" TEXT,
ADD COLUMN "roundTemplate" TEXT,
ADD COLUMN "winnerTemplate" TEXT,
ADD COLUMN "buttonsTemplate" TEXT;
ALTER TABLE "Battle" ADD COLUMN "finalMinutes" INTEGER;
ALTER TABLE "Duel" ADD COLUMN "readyAt" TIMESTAMP(3),
ADD COLUMN "remindedAt" TIMESTAMP(3);
