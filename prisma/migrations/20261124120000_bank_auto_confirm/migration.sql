-- Admins can switch automatic confirmation of jar transfers off
ALTER TABLE "BotSettings" ADD COLUMN "bankAutoConfirm" BOOLEAN NOT NULL DEFAULT true;
