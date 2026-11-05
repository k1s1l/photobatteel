-- Tournament redesign: entries are collected until a scheduled start and played as duels.
-- Data from the previous single-post publishing mode is mapped to the new statuses.

-- Audit entries of removed actions
DELETE FROM "ActivityLog" WHERE "action"::text IN ('PHOTO_PUBLISHED', 'PHOTO_PUBLISH_FAILED', 'PHOTO_REQUEUED', 'PUBLISHING_PAUSED', 'PUBLISHING_RESUMED', 'BATTLE_VOTING_STARTED');
-- Paid votes were bound to single posts; they cannot be mapped to duels
DELETE FROM "PaidVote";

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('PHOTO', 'VIDEO');

-- CreateEnum
CREATE TYPE "DuelStatus" AS ENUM ('PENDING', 'ACTIVE', 'FINISHED');

-- CreateEnum
CREATE TYPE "DuelSide" AS ENUM ('A', 'B');

-- AlterEnum
BEGIN;
CREATE TYPE "ActivityAction_new" AS ENUM ('USER_REGISTERED', 'CONSENT_GIVEN', 'PHOTO_UPLOADED', 'PHOTO_CONFIRMED', 'PHOTO_CANCELLED', 'PHOTO_APPROVED', 'PHOTO_REJECTED', 'PHOTO_DELETED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'SETTINGS_UPDATED', 'TEMPLATE_UPDATED', 'BROADCAST_CREATED', 'BROADCAST_FINISHED', 'BATTLE_CREATED', 'BATTLE_STARTED', 'BATTLE_ROUND_STARTED', 'BATTLE_FINISHED', 'BATTLE_CANCELLED', 'DUEL_POST_FAILED', 'ADMIN_ACCESS_DENIED', 'USER_DATA_DELETED', 'PAYMENT_SUCCEEDED', 'PAYMENT_REFUNDED', 'PAID_VOTES_SPENT', 'PACKAGE_UPDATED', 'LANGUAGE_CHANGED');
ALTER TABLE "ActivityLog" ALTER COLUMN "action" TYPE "ActivityAction_new" USING ("action"::text::"ActivityAction_new");
ALTER TYPE "ActivityAction" RENAME TO "ActivityAction_old";
ALTER TYPE "ActivityAction_new" RENAME TO "ActivityAction";
DROP TYPE "public"."ActivityAction_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "BattleStatus_new" AS ENUM ('SCHEDULED', 'RUNNING', 'FINISHED', 'CANCELLED');
ALTER TABLE "public"."Battle" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Battle" ALTER COLUMN "status" TYPE "BattleStatus_new" USING (
  CASE WHEN "status"::text IN ('ACTIVE', 'VOTING') THEN 'CANCELLED' ELSE "status"::text END
)::"BattleStatus_new";
ALTER TYPE "BattleStatus" RENAME TO "BattleStatus_old";
ALTER TYPE "BattleStatus_new" RENAME TO "BattleStatus";
DROP TYPE "public"."BattleStatus_old";
ALTER TABLE "Battle" ALTER COLUMN "status" SET DEFAULT 'SCHEDULED';
COMMIT;

-- AlterEnum
ALTER TYPE "PhotoSource" ADD VALUE 'VIDEO';

-- AlterEnum
BEGIN;
CREATE TYPE "PhotoStatus_new" AS ENUM ('DRAFT', 'PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER', 'REJECTED', 'DELETED', 'CANCELLED');
ALTER TABLE "public"."Photo" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Photo" ALTER COLUMN "status" TYPE "PhotoStatus_new" USING (
  CASE "status"::text
    WHEN 'PUBLISHED' THEN 'ELIMINATED'
    WHEN 'QUEUED' THEN 'CANCELLED'
    WHEN 'FAILED' THEN 'CANCELLED'
    ELSE "status"::text
  END
)::"PhotoStatus_new";
ALTER TYPE "PhotoStatus" RENAME TO "PhotoStatus_old";
ALTER TYPE "PhotoStatus_new" RENAME TO "PhotoStatus";
DROP TYPE "public"."PhotoStatus_old";
ALTER TABLE "Photo" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- DropForeignKey
ALTER TABLE "Publication" DROP CONSTRAINT "Publication_photoId_fkey";

-- DropForeignKey
ALTER TABLE "PublicationQueue" DROP CONSTRAINT "PublicationQueue_photoId_fkey";

-- DropForeignKey
ALTER TABLE "Vote" DROP CONSTRAINT "Vote_photoId_fkey";

-- DropForeignKey
ALTER TABLE "Vote" DROP CONSTRAINT "Vote_userId_fkey";

-- DropIndex
DROP INDEX "Battle_status_endsAt_idx";

-- DropIndex
DROP INDEX "Battle_status_submissionsEndAt_idx";

-- DropIndex
DROP INDEX "Photo_battleId_votesCount_idx";

-- AlterTable
ALTER TABLE "Battle" DROP COLUMN "endsAt",
DROP COLUMN "isWeekly",
DROP COLUMN "submissionsEndAt",
DROP COLUMN "theme",
ADD COLUMN     "currentRound" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "roundMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "tiebreakMinutes" INTEGER NOT NULL DEFAULT 10,
ALTER COLUMN "status" SET DEFAULT 'SCHEDULED',
ALTER COLUMN "startsAt" DROP DEFAULT;
ALTER TABLE "Battle" ALTER COLUMN "roundMinutes" DROP DEFAULT;

-- AlterTable
ALTER TABLE "BotSettings" DROP COLUMN "maxPhotosPerDay",
DROP COLUMN "maxQueuedPerUser",
DROP COLUMN "publishIntervalMinutes",
DROP COLUMN "publishingPaused",
DROP COLUMN "submissionsOnlyInBattle",
DROP COLUMN "votingEnabled",
DROP COLUMN "weeklyBattlesEnabled",
ADD COLUMN     "duelTemplate" TEXT,
ADD COLUMN     "subscribersOnly" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "PaidVote" ADD COLUMN     "duelId" INTEGER NOT NULL,
ADD COLUMN     "side" "DuelSide" NOT NULL,
ADD COLUMN     "stage" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Photo" DROP COLUMN "publishedAt",
ADD COLUMN     "durationSec" INTEGER,
ADD COLUMN     "mediaType" "MediaType" NOT NULL DEFAULT 'PHOTO';

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "languageCode" SET DEFAULT '';

-- DropTable
DROP TABLE "Publication";

-- DropTable
DROP TABLE "PublicationQueue";

-- DropTable
DROP TABLE "Vote";

-- DropEnum
DROP TYPE "QueueStatus";

-- CreateTable
CREATE TABLE "Duel" (
    "id" SERIAL NOT NULL,
    "battleId" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "photoAId" INTEGER NOT NULL,
    "photoBId" INTEGER,
    "status" "DuelStatus" NOT NULL DEFAULT 'PENDING',
    "stage" INTEGER NOT NULL DEFAULT 0,
    "votesA" INTEGER NOT NULL DEFAULT 0,
    "votesB" INTEGER NOT NULL DEFAULT 0,
    "messageId" INTEGER,
    "mediaMessageIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "postedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "winnerPhotoId" INTEGER,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Duel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuelVote" (
    "id" SERIAL NOT NULL,
    "duelId" INTEGER NOT NULL,
    "stage" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "side" "DuelSide" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DuelVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Duel_status_endsAt_idx" ON "Duel"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Duel_battleId_round_position_key" ON "Duel"("battleId", "round", "position");

-- CreateIndex
CREATE INDEX "DuelVote_userId_idx" ON "DuelVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DuelVote_duelId_stage_userId_key" ON "DuelVote"("duelId", "stage", "userId");

-- CreateIndex
CREATE INDEX "Battle_status_startsAt_idx" ON "Battle"("status", "startsAt");

-- CreateIndex
CREATE INDEX "PaidVote_duelId_stage_idx" ON "PaidVote"("duelId", "stage");

-- CreateIndex
CREATE INDEX "Photo_battleId_status_idx" ON "Photo"("battleId", "status");

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_photoAId_fkey" FOREIGN KEY ("photoAId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_photoBId_fkey" FOREIGN KEY ("photoBId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duel" ADD CONSTRAINT "Duel_winnerPhotoId_fkey" FOREIGN KEY ("winnerPhotoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelVote" ADD CONSTRAINT "DuelVote_duelId_fkey" FOREIGN KEY ("duelId") REFERENCES "Duel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuelVote" ADD CONSTRAINT "DuelVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaidVote" ADD CONSTRAINT "PaidVote_duelId_fkey" FOREIGN KEY ("duelId") REFERENCES "Duel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

