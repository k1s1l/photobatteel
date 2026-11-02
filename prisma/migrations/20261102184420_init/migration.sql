-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('DRAFT', 'PENDING_MODERATION', 'QUEUED', 'PUBLISHED', 'REJECTED', 'DELETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PhotoSource" AS ENUM ('PHOTO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'PROCESSING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BattleStatus" AS ENUM ('ACTIVE', 'VOTING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('USER_REGISTERED', 'CONSENT_GIVEN', 'PHOTO_UPLOADED', 'PHOTO_CONFIRMED', 'PHOTO_CANCELLED', 'PHOTO_APPROVED', 'PHOTO_REJECTED', 'PHOTO_PUBLISHED', 'PHOTO_PUBLISH_FAILED', 'PHOTO_REQUEUED', 'PHOTO_DELETED', 'USER_BLOCKED', 'USER_UNBLOCKED', 'PUBLISHING_PAUSED', 'PUBLISHING_RESUMED', 'SETTINGS_UPDATED', 'BROADCAST_CREATED', 'BROADCAST_FINISHED', 'BATTLE_CREATED', 'BATTLE_VOTING_STARTED', 'BATTLE_FINISHED', 'BATTLE_CANCELLED', 'ADMIN_ACCESS_DENIED', 'USER_DATA_DELETED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "languageCode" TEXT NOT NULL DEFAULT 'ru',
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "botBlockedAt" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3),
    "photosSubmitted" INTEGER NOT NULL DEFAULT 0,
    "photosPublished" INTEGER NOT NULL DEFAULT 0,
    "votesReceived" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "userId" INTEGER,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "battleId" INTEGER,
    "source" "PhotoSource" NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileUniqueId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "status" "PhotoStatus" NOT NULL DEFAULT 'DRAFT',
    "votesCount" INTEGER NOT NULL DEFAULT 0,
    "previewMessageId" INTEGER,
    "rejectionReason" TEXT,
    "moderatedById" INTEGER,
    "moderatedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationQueue" (
    "id" SERIAL NOT NULL,
    "photoId" INTEGER NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" INTEGER,
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicationQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" SERIAL NOT NULL,
    "photoId" INTEGER NOT NULL,
    "channelId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "publishedById" INTEGER,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vote" (
    "id" SERIAL NOT NULL,
    "photoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Battle" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "theme" TEXT,
    "status" "BattleStatus" NOT NULL DEFAULT 'ACTIVE',
    "isWeekly" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submissionsEndAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "winnerPhotoId" INTEGER,
    "createdById" INTEGER,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Battle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publishingPaused" BOOLEAN NOT NULL DEFAULT false,
    "publishIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "moderationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "votingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "maxPhotosPerDay" INTEGER NOT NULL DEFAULT 3,
    "maxQueuedPerUser" INTEGER NOT NULL DEFAULT 5,
    "maxPhotosPerBattle" INTEGER NOT NULL DEFAULT 1,
    "submissionsOnlyInBattle" BOOLEAN NOT NULL DEFAULT false,
    "weeklyBattlesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" SERIAL NOT NULL,
    "createdById" INTEGER NOT NULL,
    "fromChatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'PENDING',
    "lastUserId" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" SERIAL NOT NULL,
    "action" "ActivityAction" NOT NULL,
    "userId" INTEGER,
    "telegramId" BIGINT,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "User_votesReceived_idx" ON "User"("votesReceived");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_telegramId_key" ON "Admin"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_userId_key" ON "Admin"("userId");

-- CreateIndex
CREATE INDEX "Photo_userId_status_idx" ON "Photo"("userId", "status");

-- CreateIndex
CREATE INDEX "Photo_status_createdAt_idx" ON "Photo"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Photo_contentHash_idx" ON "Photo"("contentHash");

-- CreateIndex
CREATE INDEX "Photo_fileUniqueId_idx" ON "Photo"("fileUniqueId");

-- CreateIndex
CREATE INDEX "Photo_battleId_votesCount_idx" ON "Photo"("battleId", "votesCount");

-- CreateIndex
CREATE UNIQUE INDEX "PublicationQueue_photoId_key" ON "PublicationQueue"("photoId");

-- CreateIndex
CREATE INDEX "PublicationQueue_status_priority_enqueuedAt_idx" ON "PublicationQueue"("status", "priority", "enqueuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_photoId_key" ON "Publication"("photoId");

-- CreateIndex
CREATE INDEX "Publication_publishedAt_idx" ON "Publication"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Publication_channelId_messageId_key" ON "Publication"("channelId", "messageId");

-- CreateIndex
CREATE INDEX "Vote_userId_idx" ON "Vote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Vote_photoId_userId_key" ON "Vote"("photoId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Battle_winnerPhotoId_key" ON "Battle"("winnerPhotoId");

-- CreateIndex
CREATE INDEX "Battle_status_submissionsEndAt_idx" ON "Battle"("status", "submissionsEndAt");

-- CreateIndex
CREATE INDEX "Battle_status_endsAt_idx" ON "Battle"("status", "endsAt");

-- CreateIndex
CREATE INDEX "ActivityLog_action_createdAt_idx" ON "ActivityLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_userId_createdAt_idx" ON "ActivityLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationQueue" ADD CONSTRAINT "PublicationQueue_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_winnerPhotoId_fkey" FOREIGN KEY ("winnerPhotoId") REFERENCES "Photo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
