import type { Battle, MediaType, Photo, PhotoSource, PhotoStatus, Prisma, PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import { escapeHtml, formatPhotoId } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BattleService } from '../battles/battle.service.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/** Statuses meaning "this file already takes part in Photo Battle" (duplicate protection). */
const USED_STATUSES: PhotoStatus[] = ['PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER', 'REJECTED'];
/** Entries that count towards the per-battle limit. */
const COUNTED_STATUSES: PhotoStatus[] = ['PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER'];
const REMOVABLE_STATUSES: PhotoStatus[] = ['DRAFT', 'PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER', 'REJECTED'];

export interface DraftInput {
  mediaType: MediaType;
  source: PhotoSource;
  fileId: string;
  fileUniqueId: string;
  contentHash: string;
  mimeType: string;
  width: number;
  height: number;
  fileSize: number;
  durationSec?: number | null;
}

export interface Actor {
  userId: number;
  isAdmin: boolean;
}

export type PhotoDetails = Photo & { user: User; battle: Battle | null };

export interface ConfirmResult {
  photo: Photo;
  battle: Battle;
  moderation: boolean;
}

export interface DeleteResult {
  photo: Photo;
  /** True when the entry was playing in a running battle and its duel was forfeited. */
  forfeited: boolean;
}

/** Entries (photos and videos) submitted to the open battle. */
export class PhotoService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly battles: BattleService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
  ) {}

  /** Checks blocking, consent, the open battle and the per-battle limit. Returns the open battle. */
  async assertCanSubmit(user: User): Promise<Battle> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    if (!user.consentAt) throw new DomainError('CONSENT_REQUIRED');
    return this.checkBattle(this.prisma, user.id);
  }

  async createDraft(user: User, input: DraftInput): Promise<Photo> {
    await this.assertCanSubmit(user);
    const duplicate = await this.prisma.photo.findFirst({
      where: { status: { in: USED_STATUSES }, OR: [{ contentHash: input.contentHash }, { fileUniqueId: input.fileUniqueId }] },
      select: { id: true },
    });
    if (duplicate) throw new DomainError('DUPLICATE_PHOTO');

    return this.prisma.$transaction(async (tx) => {
      // Only one draft at a time: older previews become invalid.
      await tx.photo.updateMany({ where: { userId: user.id, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
      const photo = await tx.photo.create({ data: { ...input, durationSec: input.durationSec ?? null, userId: user.id, status: 'DRAFT' } });
      await this.activity.log({ action: 'PHOTO_UPLOADED', userId: user.id, entityType: 'Photo', entityId: photo.id }, tx);
      return photo;
    });
  }

  /** Stores the preview message and, for image files, the photo file_id produced by the preview upload. */
  async attachPreview(photoId: number, previewMessageId: number, publishFileId?: string): Promise<void> {
    await this.prisma.photo.update({ where: { id: photoId }, data: { previewMessageId, ...(publishFileId ? { fileId: publishFileId } : {}) } });
  }

  async cancelDraft(photoId: number, userId: number): Promise<Photo> {
    const result = await this.prisma.photo.updateMany({ where: { id: photoId, userId, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
    if (result.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'PHOTO_CANCELLED', userId, entityType: 'Photo', entityId: photoId });
    return this.prisma.photo.findUniqueOrThrow({ where: { id: photoId } });
  }

  /** Final confirmation by the author; idempotent through the DRAFT status guard. */
  async confirm(photoId: number, userId: number): Promise<ConfirmResult> {
    const moderation = (await this.settings.get()).moderationEnabled;
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.isBlocked) throw new DomainError('USER_BLOCKED');
      if (!user.consentAt) throw new DomainError('CONSENT_REQUIRED');
      const draft = await tx.photo.findFirst({ where: { id: photoId, userId } });
      if (!draft) throw new DomainError('NOT_FOUND');
      if (draft.status !== 'DRAFT') throw new DomainError('INVALID_STATE');
      const battle = await this.checkBattle(tx, userId);

      const updated = await tx.photo.updateMany({
        where: { id: photoId, userId, status: 'DRAFT' },
        data: { status: moderation ? 'PENDING_MODERATION' : 'ACCEPTED', confirmedAt: new Date(), battleId: battle.id },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.user.update({ where: { id: userId }, data: { photosSubmitted: { increment: 1 } } });
      await this.activity.log({ action: 'PHOTO_CONFIRMED', userId, entityType: 'Photo', entityId: photoId }, tx);
      return { photo: await tx.photo.findUniqueOrThrow({ where: { id: photoId } }), battle, moderation };
    });
  }

  /** Moderator approval; only possible while the battle still accepts entries. */
  async approve(photoId: number, adminUserId: number): Promise<Photo> {
    const photo = await this.prisma.$transaction(async (tx) => {
      const current = await tx.photo.findUnique({ where: { id: photoId }, include: { battle: true } });
      if (current?.status !== 'PENDING_MODERATION' || current.battle?.status !== 'SCHEDULED') throw new DomainError('INVALID_STATE');
      await tx.photo.update({ where: { id: photoId }, data: { status: 'ACCEPTED', moderatedById: adminUserId, moderatedAt: new Date() } });
      await this.activity.log({ action: 'PHOTO_APPROVED', userId: adminUserId, entityType: 'Photo', entityId: photoId }, tx);
      return tx.photo.findUniqueOrThrow({ where: { id: photoId }, include: { user: true } });
    });
    await this.notifications.notifyUser(photo.user, (l) => l.notifications.approved(formatPhotoId(photoId)));
    return photo;
  }

  /** Rejects an entry that has not started playing yet. */
  async reject(photoId: number, adminUserId: number, reason: string): Promise<Photo> {
    const photo = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.photo.updateMany({
        where: { id: photoId, status: { in: ['PENDING_MODERATION', 'ACCEPTED'] } },
        data: { status: 'REJECTED', rejectionReason: reason.slice(0, 200), moderatedById: adminUserId, moderatedAt: new Date() },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await this.activity.log({ action: 'PHOTO_REJECTED', userId: adminUserId, entityType: 'Photo', entityId: photoId, details: { reason } }, tx);
      return tx.photo.findUniqueOrThrow({ where: { id: photoId }, include: { user: true } });
    });
    await this.notifications.notifyUser(photo.user, (l) => l.notifications.rejected({ id: formatPhotoId(photoId), reason: escapeHtml(reason) }));
    return photo;
  }

  /**
   * Deletes an entry for its author or an admin. An entry still playing
   * forfeits its open duel (the opponent advances, the duel post is removed).
   */
  async delete(photoId: number, actor: Actor): Promise<DeleteResult> {
    const current = await this.prisma.photo.findUnique({ where: { id: photoId }, include: { user: true } });
    if (!current) throw new DomainError('NOT_FOUND');
    if (!actor.isAdmin && current.userId !== actor.userId) throw new DomainError('FORBIDDEN');
    const updated = await this.prisma.photo.updateMany({
      where: { id: photoId, status: { in: REMOVABLE_STATUSES } },
      data: { status: 'DELETED', deletedAt: new Date() },
    });
    if (updated.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'PHOTO_DELETED', userId: actor.userId, entityType: 'Photo', entityId: photoId, details: { byAdmin: actor.isAdmin } });

    const forfeited = current.status === 'IN_BATTLE';
    if (forfeited) await this.battles.forfeit(photoId);
    if (actor.isAdmin && current.userId !== actor.userId) {
      await this.notifications.notifyUser(current.user, (l) => l.notifications.deletedByAdmin(formatPhotoId(photoId)));
    }
    return { photo: await this.prisma.photo.findUniqueOrThrow({ where: { id: photoId } }), forfeited };
  }

  /** Deletes all entries of the user (data deletion request). Returns the number deleted. */
  async deleteAllForUser(userId: number): Promise<number> {
    const photos = await this.prisma.photo.findMany({ where: { userId, status: { in: REMOVABLE_STATUSES } }, select: { id: true } });
    let deleted = 0;
    for (const { id } of photos) {
      try {
        await this.delete(id, { userId, isAdmin: false });
        deleted += 1;
      } catch (error) {
        this.logger.warn({ err: error, photoId: id }, 'Failed to delete entry during data deletion');
      }
    }
    await this.activity.log({ action: 'USER_DATA_DELETED', userId, details: { deleted } });
    return deleted;
  }

  async getDetails(photoId: number): Promise<PhotoDetails | null> {
    return this.prisma.photo.findUnique({ where: { id: photoId }, include: { user: true, battle: true } });
  }

  async listByUser(userId: number, page: number, pageSize: number): Promise<{ items: Photo[]; total: number }> {
    const where: Prisma.PhotoWhereInput = { userId, status: { not: 'CANCELLED' } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.photo.findMany({ where, orderBy: { id: 'desc' }, skip: page * pageSize, take: pageSize }),
      this.prisma.photo.count({ where }),
    ]);
    return { items, total };
  }

  async listAll(filter: { status?: PhotoStatus; userId?: number }, page: number, pageSize: number): Promise<{ items: (Photo & { user: User })[]; total: number }> {
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

  /** Cancels drafts that were never confirmed. */
  async expireDrafts(ttlHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000);
    const result = await this.prisma.photo.updateMany({ where: { status: 'DRAFT', createdAt: { lt: cutoff } }, data: { status: 'CANCELLED' } });
    return result.count;
  }

  private async checkBattle(db: Prisma.TransactionClient | PrismaClient, userId: number): Promise<Battle> {
    const battle = await this.battles.getOpen(db);
    if (!battle) throw new DomainError('NO_ACTIVE_BATTLE');
    const { maxPhotosPerBattle } = await this.settings.get();
    if (maxPhotosPerBattle > 0) {
      const entries = await db.photo.count({ where: { userId, battleId: battle.id, status: { in: COUNTED_STATUSES } } });
      if (entries >= maxPhotosPerBattle) throw new DomainError('BATTLE_LIMIT', { limit: maxPhotosPerBattle });
    }
    return battle;
  }
}
