-- Manual publishing: duel posts are prepared for admins, who publish them in the channel.
ALTER TYPE "DuelStatus" ADD VALUE 'READY' AFTER 'PENDING';
ALTER TABLE "Duel" ADD COLUMN "preparedFileUniqueId" TEXT;
