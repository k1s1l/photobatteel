import type { Battle, Photo, PhotoSource, PhotoStatus, Prisma, PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import { channelPostLink, formatPhotoId } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { Locale } from '../../i18n/index.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BattleService } from '../battles/battle.service.js';
import type { ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/** Statuses meaning "this image already takes part in Photo Battle". */
const USED_STATUSES: PhotoStatus[] = ['PENDING_MODERATION', 'QUEUED', 'PUBLISHED', 'FAILED', 'REJECTED'];
const WAITING_STATUSES: PhotoStatus[] = ['PENDING_MODERATION', 'QUEUED'];
const REMOVABLE_STATUSES: PhotoStatus[] = ['DRAFT', 'PENDING_MODERATION', 'QUEUED', 'PUBLISHED', 'REJECTED', 'FAILED'];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DraftInput {
  source: PhotoSource;
  fileId: string;
  fileUniqueId: string;
  contentHash: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
}

export interface Actor {
  userId: number;
  isAdmin: boolean;
}

export type PhotoDetails = Photo & {
  user: User;
  battle: Battle | null;
  publication: { messageId: number; channelId: bigint; removedAt: Date | null } | null;
  queueItem: { status: string; attempts: number; lastError: string | null } | null;
};

export interface ConfirmResult {
  photo: Photo;
  moderation: boolean;
  queuePosition: number | null;
}

export interface DeleteResult {
  photo: Photo;
  /** null — photo was not published; true/false — whether the channel post was removed. */
  channelRemoved: boolean | null;
}

export class PhotoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly battles: BattleService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly telegram: TelegramGateway,
    private readonly scheduler: JobScheduler,
    private readonly channel: ChannelInfo,
    private readonly locale: Locale,
    private readonly logger: Logger,
  ) {}

  /** Checks blocking, consent and limits before accepting a new upload. Returns the battle the photo would join. */
  async assertCanSubmit(user: User): Promise<Battle | null> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    if (!user.consentAt) throw new DomainError('CONSENT_REQUIRED');
    return this.checkLimits(this.prisma, user.id);
  }

  async createDraft(user: User, input: DraftInput): Promise<Photo> {
    await this.assertCanSubmit(user);
    const duplicate = await this.prisma.photo.findFirst({
      where: {
        status: { in: USED_STATUSES },
        OR: [{ contentHash: input.contentHash }, { fileUniqueId: input.fileUniqueId }],
      },
      select: { id: true },
    });
    if (duplicate) throw new DomainError('DUPLICATE_PHOTO');

    return this.prisma.$transaction(async (tx) => {
      // Only one draft at a time: older previews become invalid.
      await tx.photo.updateMany({ where: { userId: user.id, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
      const photo = await tx.photo.create({ data: { ...input, userId: user.id, status: 'DRAFT' } });
      await this.activity.log({ action: 'PHOTO_UPLOADED', userId: user.id, entityType: 'Photo', entityId: photo.id }, tx);
      return photo;
    });
  }

  /** Stores the preview message and, for files, the photo file_id produced by the preview upload. */
  async attachPreview(photoId: number, previewMessageId: number, publishFileId?: string): Promise<void> {
    await this.prisma.photo.update({
      where: { id: photoId },
      data: { previewMessageId, ...(publishFileId ? { fileId: publishFileId } : {}) },
    });
  }

  async cancelDraft(photoId: number, userId: number): Promise<Photo> {
    const result = await this.prisma.photo.updateMany({ where: { id: photoId, userId, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
    if (result.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'PHOTO_CANCELLED', userId, entityType: 'Photo', entityId: photoId });
    return this.prisma.photo.findUniqueOrThrow({ where: { id: photoId } });
  }

  /**
   * Final confirmation by the author. The status guard (DRAFT -> ...) makes the
   * operation idempotent: repeated presses get INVALID_STATE.
   */
  async confirm(photoId: number, userId: number): Promise<ConfirmResult> {
    const settings = await this.settings.get();
    const moderation = settings.moderationEnabled;

    const photo = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.isBlocked) throw new DomainError('USER_BLOCKED');
      if (!user.consentAt) throw new DomainError('CONSENT_REQUIRED');
      const draft = await tx.photo.findFirst({ where: { id: photoId, userId } });
      if (!draft) throw new DomainError('NOT_FOUND');
      if (draft.status !== 'DRAFT') throw new DomainError('INVALID_STATE');
      const battle = await this.checkLimits(tx, userId);

      const updated = await tx.photo.updateMany({
        where: { id: photoId, userId, status: 'DRAFT' },
        data: { status: moderation ? 'PENDING_MODERATION' : 'QUEUED', confirmedAt: new Date(), battleId: battle?.id ?? null },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      if (!moderation) await tx.publicationQueue.create({ data: { photoId } });
      await tx.user.update({ where: { id: userId }, data: { photosSubmitted: { increment: 1 } } });
      await this.activity.log({ action: 'PHOTO_CONFIRMED', userId, entityType: 'Photo', entityId: photoId }, tx);
      return tx.photo.findUniqueOrThrow({ where: { id: photoId } });
    });

    if (!moderation) await this.scheduler.triggerPublishTick();
    const queuePosition = moderation ? null : await this.queuePosition(photoId);
    return { photo, moderation, queuePosition };
  }

  async approve(photoId: number, adminUserId: number): Promise<Photo> {
    const photo = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.photo.updateMany({
        where: { id: photoId, status: 'PENDING_MODERATION' },
        data: { status: 'QUEUED', moderatedById: adminUserId, moderatedAt: new Date() },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.publicationQueue.upsert({
        where: { photoId },
        create: { photoId },
        update: { status: 'WAITING', attempts: 0, lastError: null, enqueuedAt: new Date() },
      });
      await this.activity.log({ action: 'PHOTO_APPROVED', userId: adminUserId, entityType: 'Photo', entityId: photoId }, tx);
      return tx.photo.findUniqueOrThrow({ where: { id: photoId }, include: { user: true } });
    });
    await this.scheduler.triggerPublishTick();
    await this.notifications.notifyUser(photo.user.telegramId, this.locale.notifications.approved(formatPhotoId(photoId)));
    return photo;
  }

  /** Rejects a photo that has not been published yet and removes it from the queue. */
  async reject(photoId: number, adminUserId: number, reason: string): Promise<Photo> {
    const photo = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.photo.updateMany({
        where: { id: photoId, status: { in: ['PENDING_MODERATION', 'QUEUED', 'FAILED'] } },
        data: { status: 'REJECTED', rejectionReason: reason.slice(0, 200), moderatedById: adminUserId, moderatedAt: new Date() },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.publicationQueue.updateMany({
        where: { photoId, status: { in: ['WAITING', 'PROCESSING', 'FAILED'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      await this.activity.log(
        { action: 'PHOTO_REJECTED', userId: adminUserId, entityType: 'Photo', entityId: photoId, details: { reason } },
        tx,
      );
      return tx.photo.findUniqueOrThrow({ where: { id: photoId }, include: { user: true } });
    });
    await this.notifications.notifyUser(photo.user.telegramId, this.locale.notifications.rejected({ id: formatPhotoId(photoId), reason }));
    return photo;
  }

  /**
   * Deletes a photo on behalf of its author or an admin. Published posts are
   * removed from the channel (best effort) and their votes no longer count.
   */
  async delete(photoId: number, actor: Actor): Promise<DeleteResult> {
    const { photo, publication } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.photo.findUnique({ where: { id: photoId }, include: { publication: true } });
      if (!current) throw new DomainError('NOT_FOUND');
      if (!actor.isAdmin && current.userId !== actor.userId) throw new DomainError('FORBIDDEN');
      const updated = await tx.photo.updateMany({
        where: { id: photoId, status: { in: REMOVABLE_STATUSES } },
        data: { status: 'DELETED', deletedAt: new Date() },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.publicationQueue.updateMany({
        where: { photoId, status: { in: ['WAITING', 'PROCESSING', 'FAILED'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      if (current.status === 'PUBLISHED') {
        await tx.user.update({
          where: { id: current.userId },
          data: { votesReceived: { decrement: current.votesCount } },
        });
      }
      await this.activity.log(
        { action: 'PHOTO_DELETED', userId: actor.userId, entityType: 'Photo', entityId: photoId, details: { byAdmin: actor.isAdmin } },
        tx,
      );
      const photo = await tx.photo.findUniqueOrThrow({ where: { id: photoId }, include: { user: true } });
      return { photo, publication: current.publication && !current.publication.removedAt ? current.publication : null };
    });

    let channelRemoved: boolean | null = null;
    if (publication) {
      channelRemoved = await this.removeChannelPost(photoId, publication.id, publication.messageId);
      if (!channelRemoved) {
        const link = channelPostLink(this.channel, publication.messageId);
        await this.notifications.notifyAdmins(this.locale.admin.channelDeleteFailed({ id: formatPhotoId(photoId), link }));
      }
    }
    if (actor.isAdmin && photo.userId !== actor.userId) {
      await this.notifications.notifyUser(photo.user.telegramId, this.locale.notifications.deletedByAdmin(formatPhotoId(photoId)));
    }
    return { photo, channelRemoved };
  }

  /** Deletes all photos of the user (GDPR-style request). Returns the number of deleted photos. */
  async deleteAllForUser(userId: number): Promise<number> {
    const photos = await this.prisma.photo.findMany({ where: { userId, status: { in: REMOVABLE_STATUSES } }, select: { id: true } });
    let deleted = 0;
    for (const { id } of photos) {
      try {
        await this.delete(id, { userId, isAdmin: false });
        deleted += 1;
      } catch (error) {
        this.logger.warn({ err: error, photoId: id }, 'Failed to delete photo during data deletion');
      }
    }
    await this.activity.log({ action: 'USER_DATA_DELETED', userId, details: { deleted } });
    return deleted;
  }

  /** Moves a permanently failed photo back to the end of the queue. */
  async requeue(photoId: number, adminUserId: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.photo.updateMany({ where: { id: photoId, status: 'FAILED' }, data: { status: 'QUEUED' } });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.publicationQueue.update({
        where: { photoId },
        data: { status: 'WAITING', attempts: 0, lastError: null, enqueuedAt: new Date(), finishedAt: null },
      });
      await this.activity.log({ action: 'PHOTO_REQUEUED', userId: adminUserId, entityType: 'Photo', entityId: photoId }, tx);
    });
    await this.scheduler.triggerPublishTick();
  }

  async getDetails(photoId: number): Promise<PhotoDetails | null> {
    return this.prisma.photo.findUnique({
      where: { id: photoId },
      include: {
        user: true,
        battle: true,
        publication: { select: { messageId: true, channelId: true, removedAt: true } },
        queueItem: { select: { status: true, attempts: true, lastError: true } },
      },
    });
  }

  async listByUser(userId: number, page: number, pageSize: number): Promise<{ items: Photo[]; total: number }> {
    const where: Prisma.PhotoWhereInput = { userId, status: { not: 'CANCELLED' } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.photo.findMany({ where, orderBy: { id: 'desc' }, skip: page * pageSize, take: pageSize }),
      this.prisma.photo.count({ where }),
    ]);
    return { items, total };
  }

  async listAll(
    filter: { status?: PhotoStatus; userId?: number },
    page: number,
    pageSize: number,
  ): Promise<{ items: (Photo & { user: User })[]; total: number }> {
    const where: Prisma.PhotoWhereInput = {
      ...(filter.userId ? { userId: filter.userId } : {}),
      status: filter.status ?? { notIn: ['DRAFT', 'CANCELLED'] },
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.photo.findMany({
        where,
        include: { user: true },
        orderBy: filter.status === 'PENDING_MODERATION' ? { confirmedAt: 'asc' } : { id: 'desc' },
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.photo.count({ where }),
    ]);
    return { items, total };
  }

  /** 1-based position among photos waiting for publication, or null if not queued. */
  async queuePosition(photoId: number): Promise<number | null> {
    const item = await this.prisma.publicationQueue.findUnique({ where: { photoId } });
    if (!item || (item.status !== 'WAITING' && item.status !== 'PROCESSING')) return null;
    return this.prisma.publicationQueue.count({
      where: {
        status: { in: ['WAITING', 'PROCESSING'] },
        OR: [
          { status: 'PROCESSING' },
          { priority: { gt: item.priority } },
          { priority: item.priority, enqueuedAt: { lt: item.enqueuedAt } },
          { priority: item.priority, enqueuedAt: item.enqueuedAt, id: { lte: item.id } },
        ],
      },
    });
  }

  /** Cancels drafts that were never confirmed. */
  async expireDrafts(ttlHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const result = await this.prisma.photo.updateMany({ where: { status: 'DRAFT', createdAt: { lt: cutoff } }, data: { status: 'CANCELLED' } });
    return result.count;
  }

  private async removeChannelPost(photoId: number, publicationId: number, messageId: number): Promise<boolean> {
    try {
      await this.telegram.deleteMessage(this.channel.id, messageId);
    } catch (error) {
      const classified = classifyTelegramError(error);
      // "message to delete not found" means it is already gone.
      if (!/message to delete not found/i.test(classified.description)) {
        this.logger.warn({ err: error, photoId, messageId }, 'Failed to delete channel post');
        return false;
      }
    }
    await this.prisma.publication.update({ where: { id: publicationId }, data: { removedAt: new Date() } });
    return true;
  }

  private async checkLimits(db: Prisma.TransactionClient | PrismaClient, userId: number): Promise<Battle | null> {
    const settings = await this.settings.get();
    const battle = await this.battles.getAcceptingBattle(db);
    if (settings.submissionsOnlyInBattle && !battle) throw new DomainError('NO_ACTIVE_BATTLE');

    if (settings.maxPhotosPerDay > 0) {
      const today = await db.photo.count({
        where: { userId, confirmedAt: { gte: new Date(Date.now() - DAY_MS) }, status: { not: 'CANCELLED' } },
      });
      if (today >= settings.maxPhotosPerDay) throw new DomainError('DAILY_LIMIT', { limit: settings.maxPhotosPerDay });
    }
    if (settings.maxQueuedPerUser > 0) {
      const waiting = await db.photo.count({ where: { userId, status: { in: WAITING_STATUSES } } });
      if (waiting >= settings.maxQueuedPerUser) throw new DomainError('QUEUE_LIMIT', { limit: settings.maxQueuedPerUser });
    }
    if (battle && settings.maxPhotosPerBattle > 0) {
      const inBattle = await db.photo.count({
        where: { userId, battleId: battle.id, status: { in: ['PENDING_MODERATION', 'QUEUED', 'PUBLISHED', 'FAILED'] } },
      });
      if (inBattle >= settings.maxPhotosPerBattle) throw new DomainError('BATTLE_LIMIT', { limit: settings.maxPhotosPerBattle });
    }
    return battle;
  }
}
