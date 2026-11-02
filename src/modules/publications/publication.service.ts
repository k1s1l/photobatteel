import type { PrismaClient, PublicationQueue } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError } from '../../lib/errors.js';
import { channelPostLink, formatPhotoId, truncate } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError, isRetryable } from '../../lib/telegram-errors.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { buildChannelCaption, buildVoteKeyboard } from './channel-post.js';

export type PublishOutcome =
  | { status: 'published'; messageId: number }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; error: string; retryAfterMs?: number }
  | { status: 'failed'; error: string };

export interface PublishingOptions {
  maxAttempts: number;
}

export type TickResult = 'paused' | 'in_flight' | 'interval' | 'empty' | 'claimed';

const PERSIST_ATTEMPTS = 5;
/** Ticks run every minute; this tolerance keeps a 5-minute interval from turning into 6 minutes. */
const INTERVAL_TOLERANCE_MS = 30_000;

/**
 * Publication queue. PostgreSQL is the source of truth for order and state;
 * BullMQ only drives timing and retries.
 *
 * Invariants:
 *  - an item is sent only while it is PROCESSING and its photo is QUEUED;
 *  - Publication.photoId is unique, so a photo can never be recorded twice;
 *  - the next WAITING item is claimed only when nothing is PROCESSING,
 *    which preserves order even while an item is being retried.
 */
export class PublicationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TelegramGateway,
    private readonly scheduler: JobScheduler,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly channel: ChannelInfo,
    private readonly locale: Locale,
    private readonly logger: Logger,
    private readonly options: PublishingOptions,
  ) {}

  /**
   * Called every minute (and right after new photos are queued): claims the next
   * photo when publishing is active and the configured interval has elapsed.
   */
  async tick(now: Date = new Date()): Promise<TickResult> {
    const inFlight = await this.prisma.publicationQueue.findMany({ where: { status: 'PROCESSING' }, select: { id: true } });
    if (inFlight.length > 0) {
      // Re-enqueue is idempotent (deterministic job ids) and recovers items whose job was lost.
      for (const item of inFlight) await this.scheduler.enqueuePublication(item.id);
      return 'in_flight';
    }
    const settings = await this.settings.get();
    if (settings.publishingPaused || settings.publishIntervalMinutes === 0) return 'paused';

    const last = await this.prisma.publication.findFirst({ orderBy: { publishedAt: 'desc' }, select: { publishedAt: true } });
    const intervalMs = settings.publishIntervalMinutes * 60_000;
    if (last && now.getTime() - last.publishedAt.getTime() < intervalMs - INTERVAL_TOLERANCE_MS) return 'interval';

    const next = await this.claimNext();
    if (!next) return 'empty';
    await this.scheduler.enqueuePublication(next.id);
    return 'claimed';
  }

  /** Atomically moves the head of the queue from WAITING to PROCESSING. */
  async claimNext(): Promise<PublicationQueue | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const head = await this.prisma.publicationQueue.findFirst({
        where: { status: 'WAITING', photo: { status: 'QUEUED' } },
        orderBy: [{ priority: 'desc' }, { enqueuedAt: 'asc' }, { id: 'asc' }],
      });
      if (!head) return null;
      const claimed = await this.prisma.publicationQueue.updateMany({
        where: { id: head.id, status: 'WAITING' },
        data: { status: 'PROCESSING', startedAt: new Date() },
      });
      if (claimed.count === 1) return { ...head, status: 'PROCESSING' };
    }
    return null;
  }

  /** Admin action: publish immediately, bypassing interval and pause. */
  async publishNow(photoId: number, adminUserId: number): Promise<void> {
    const item = await this.prisma.$transaction(async (tx) => {
      const photo = await tx.photo.findUnique({ where: { id: photoId } });
      if (!photo) throw new DomainError('NOT_FOUND');
      if (!['QUEUED', 'PENDING_MODERATION', 'FAILED'].includes(photo.status)) throw new DomainError('INVALID_STATE');
      if (photo.status !== 'QUEUED') {
        await tx.photo.update({
          where: { id: photoId },
          data: {
            status: 'QUEUED',
            ...(photo.status === 'PENDING_MODERATION' ? { moderatedById: adminUserId, moderatedAt: new Date() } : {}),
          },
        });
      }
      const existing = await tx.publicationQueue.findUnique({ where: { photoId } });
      if (existing?.status === 'PROCESSING') return existing; // already being published
      return tx.publicationQueue.upsert({
        where: { photoId },
        create: { photoId, status: 'PROCESSING', manual: true, requestedById: adminUserId, startedAt: new Date() },
        update: {
          status: 'PROCESSING',
          manual: true,
          requestedById: adminUserId,
          startedAt: new Date(),
          attempts: 0,
          lastError: null,
          finishedAt: null,
        },
      });
    });
    await this.scheduler.enqueuePublication(item.id);
  }

  /**
   * Publishes one queue item. Never throws for Telegram errors: the outcome
   * tells the job runner whether to retry.
   */
  async processItem(queueItemId: number): Promise<PublishOutcome> {
    const item = await this.prisma.publicationQueue.findUnique({
      where: { id: queueItemId },
      include: { photo: { include: { user: true, battle: true, publication: true } } },
    });
    if (!item) return { status: 'skipped', reason: 'queue item not found' };
    if (item.status !== 'PROCESSING') return { status: 'skipped', reason: `queue item is ${item.status}` };
    const { photo } = item;
    if (photo.publication || photo.status === 'PUBLISHED') {
      await this.finishItem(item.id, 'DONE');
      return { status: 'skipped', reason: 'already published' };
    }
    if (photo.status !== 'QUEUED') {
      await this.finishItem(item.id, 'CANCELLED');
      return { status: 'skipped', reason: `photo is ${photo.status}` };
    }

    const attempt = item.attempts + 1;
    await this.prisma.publicationQueue.update({ where: { id: item.id }, data: { attempts: attempt } });

    const settings = await this.settings.get();
    let messageId: number;
    try {
      const sent = await this.telegram.sendPhoto(this.channel.id, photo.fileId, {
        caption: buildChannelCaption(this.locale, photo, photo.user, photo.battle?.title ?? null),
        parseMode: 'HTML',
        ...(settings.votingEnabled ? { replyMarkup: buildVoteKeyboard(this.locale, photo.id, photo.votesCount) } : {}),
      });
      messageId = sent.message_id;
    } catch (error) {
      return this.handleSendError(item.id, photo.id, attempt, error);
    }

    // The post exists now: from here on we must never send it again.
    const recorded = await this.recordPublication(item.id, photo.id, photo.userId, messageId, item.manual, item.requestedById);
    if (!recorded) {
      // The photo was deleted/rejected while being sent — undo the post.
      await this.telegram.deleteMessage(this.channel.id, messageId).catch((err: unknown) =>
        this.logger.error({ err, photoId: photo.id, messageId }, 'Failed to remove post of a withdrawn photo'),
      );
      return { status: 'skipped', reason: 'photo withdrawn during publication' };
    }

    const link = channelPostLink(this.channel, messageId);
    const id = formatPhotoId(photo.id);
    await this.notifications.notifyUser(photo.user.telegramId, this.locale.notifications.published({ id, link }), {
      parseMode: 'HTML',
      disablePreview: true,
    });
    if (item.manual) await this.notifications.notifyAdmins(this.locale.admin.publishedNotice({ id, link, manual: true }));
    return { status: 'published', messageId };
  }

  /** Marks an item as failed after the job runner gave up (e.g. retries exhausted unexpectedly). */
  async markFailed(queueItemId: number, error: string): Promise<void> {
    const item = await this.prisma.publicationQueue.findUnique({ where: { id: queueItemId } });
    if (!item || item.status !== 'PROCESSING') return;
    await this.failItem(item.id, item.photoId, error);
  }

  async getQueue(page: number, pageSize: number) {
    const where = { status: { in: ['WAITING', 'PROCESSING', 'FAILED'] as ('WAITING' | 'PROCESSING' | 'FAILED')[] } };
    const [items, counts] = await this.prisma.$transaction([
      this.prisma.publicationQueue.findMany({
        where,
        include: { photo: { include: { user: true } } },
        orderBy: [{ status: 'desc' }, { priority: 'desc' }, { enqueuedAt: 'asc' }, { id: 'asc' }],
        skip: page * pageSize,
        take: pageSize,
      }),
      this.prisma.publicationQueue.groupBy({ by: ['status'], where, _count: { _all: true }, orderBy: { status: 'asc' } }),
    ]);
    const count = (status: string) => counts.find((row) => row.status === status)?._count?._all ?? 0;
    return {
      items,
      waiting: count('WAITING'),
      processing: count('PROCESSING'),
      failed: count('FAILED'),
      total: count('WAITING') + count('PROCESSING') + count('FAILED'),
    };
  }

  private async handleSendError(itemId: number, photoId: number, attempt: number, error: unknown): Promise<PublishOutcome> {
    const classified = classifyTelegramError(error);
    const message = truncate(classified.description, 500);
    if (isRetryable(classified) && attempt < this.options.maxAttempts) {
      await this.prisma.publicationQueue.update({ where: { id: itemId }, data: { lastError: message } });
      this.logger.warn({ photoId, attempt, error: message }, 'Publication failed, will retry');
      return { status: 'retry', error: message, ...(classified.retryAfterMs ? { retryAfterMs: classified.retryAfterMs } : {}) };
    }
    await this.failItem(itemId, photoId, message);
    return { status: 'failed', error: message };
  }

  private async failItem(itemId: number, photoId: number, error: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.publicationQueue.update({ where: { id: itemId }, data: { status: 'FAILED', lastError: error, finishedAt: new Date() } });
      await tx.photo.updateMany({ where: { id: photoId, status: 'QUEUED' }, data: { status: 'FAILED' } });
    });
    await this.activity.log({ action: 'PHOTO_PUBLISH_FAILED', entityType: 'Photo', entityId: photoId, details: { error } });
    this.logger.error({ photoId, error }, 'Publication failed permanently');
    await this.notifications.notifyAdmins(this.locale.admin.publishFailed({ id: formatPhotoId(photoId), error: truncate(error, 300) }));
  }

  private async finishItem(itemId: number, status: 'DONE' | 'CANCELLED'): Promise<void> {
    await this.prisma.publicationQueue.update({ where: { id: itemId }, data: { status, finishedAt: new Date() } });
  }

  /**
   * Persists a successful send. Retries DB errors locally instead of failing
   * the job, because failing would make the runner send the photo again.
   * Returns false if the photo was withdrawn in the meantime.
   */
  private async recordPublication(
    itemId: number,
    photoId: number,
    userId: number,
    messageId: number,
    manual: boolean,
    requestedById: number | null,
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const updated = await tx.photo.updateMany({ where: { id: photoId, status: 'QUEUED' }, data: { status: 'PUBLISHED', publishedAt: now } });
          if (updated.count === 0) {
            await tx.publicationQueue.updateMany({ where: { id: itemId, status: 'PROCESSING' }, data: { status: 'CANCELLED', finishedAt: now } });
            return false;
          }
          await tx.publication.create({
            data: { photoId, channelId: BigInt(this.channel.id), messageId, manual, publishedById: requestedById, publishedAt: now },
          });
          await tx.publicationQueue.update({ where: { id: itemId }, data: { status: 'DONE', finishedAt: now, lastError: null } });
          await tx.user.update({ where: { id: userId }, data: { photosPublished: { increment: 1 } } });
          await this.activity.log(
            { action: 'PHOTO_PUBLISHED', userId: manual ? requestedById : userId, entityType: 'Photo', entityId: photoId, details: { messageId, manual } },
            tx,
          );
          return true;
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
    this.logger.fatal({ err: lastError, photoId, messageId }, 'Photo was posted but the publication could not be recorded');
    throw new PublicationRecordError(photoId, messageId);
  }
}

/** Raised when a post exists in the channel but could not be saved; must not be retried. */
export class PublicationRecordError extends Error {
  constructor(
    public readonly photoId: number,
    public readonly messageId: number,
  ) {
    super(`Photo ${photoId} was posted as message ${messageId} but the database update failed`);
    this.name = 'PublicationRecordError';
  }
}
