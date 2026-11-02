import type { PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import { parsePhotoId } from '../../lib/format.js';
import type { ActivityService } from '../activity/activity.service.js';

export interface TelegramProfile {
  id: number;
  username?: string | undefined;
  first_name: string;
  last_name?: string | undefined;
  language_code?: string | undefined;
  is_bot?: boolean;
}

export interface UserStats {
  user: User;
  queued: number;
  rank: number | null;
}

const ACTIVE_PHOTO_STATUSES = ['PENDING_MODERATION', 'QUEUED'] as const;
const LAST_ACTIVE_RESOLUTION_MS = 5 * 60_000;

export class UserService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Registers a new user or refreshes profile data. Writes only when
   * something changed (or activity timestamp is stale) to keep the hot path cheap.
   */
  async upsertFromTelegram(profile: TelegramProfile): Promise<{ user: User; isNew: boolean }> {
    if (!Number.isSafeInteger(profile.id) || profile.id <= 0) throw new DomainError('FORBIDDEN', {}, 'Invalid Telegram id');
    const telegramId = BigInt(profile.id);
    const firstName = (profile.first_name || '').slice(0, 128) || 'Участник';
    const username = profile.username?.slice(0, 64) ?? null;
    const lastName = profile.last_name?.slice(0, 128) ?? null;

    const existing = await this.prisma.user.findUnique({ where: { telegramId } });
    if (existing) {
      const changed = existing.username !== username || existing.firstName !== firstName || existing.lastName !== lastName;
      const stale = Date.now() - existing.lastActiveAt.getTime() > LAST_ACTIVE_RESOLUTION_MS;
      if (!changed && !stale) return { user: existing, isNew: false };
      const user = await this.prisma.user.update({
        where: { id: existing.id },
        data: { username, firstName, lastName, lastActiveAt: new Date(), botBlockedAt: null },
      });
      return { user, isNew: false };
    }

    try {
      const user = await this.prisma.user.create({
        data: { telegramId, username, firstName, lastName, languageCode: profile.language_code?.slice(0, 8) ?? 'ru' },
      });
      await this.activity.log({ action: 'USER_REGISTERED', userId: user.id, telegramId });
      return { user, isNew: true };
    } catch (error) {
      // Concurrent first updates from the same user: the other request won.
      const user = await this.prisma.user.findUnique({ where: { telegramId } });
      if (user) return { user, isNew: false };
      throw error;
    }
  }

  async findById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  }

  /** Accepts a Telegram ID, @username or a photo ID (#0012) and returns its user. */
  async findByQuery(query: string): Promise<User | null> {
    const input = query.trim();
    if (input.startsWith('#')) {
      const photoId = parsePhotoId(input);
      if (!photoId) return null;
      const photo = await this.prisma.photo.findUnique({ where: { id: photoId }, include: { user: true } });
      return photo?.user ?? null;
    }
    if (/^\d{1,15}$/.test(input)) return this.findByTelegramId(Number(input));
    const username = input.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{3,64}$/.test(username)) return null;
    return this.prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } });
  }

  async giveConsent(userId: number): Promise<User> {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { consentAt: new Date() } });
    await this.activity.log({ action: 'CONSENT_GIVEN', userId });
    return user;
  }

  /**
   * Blocks a user and withdraws their photos that are not published yet.
   * Returns the number of withdrawn photos.
   */
  async block(targetId: number, actorUserId: number, reason: string): Promise<{ user: User; cancelledPhotos: number }> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) throw new DomainError('NOT_FOUND');
      if (target.isBlocked) throw new DomainError('INVALID_STATE');
      const user = await tx.user.update({
        where: { id: targetId },
        data: { isBlocked: true, blockedAt: new Date(), blockedReason: reason.slice(0, 200) },
      });
      const pending = await tx.photo.findMany({
        where: { userId: targetId, status: { in: [...ACTIVE_PHOTO_STATUSES, 'DRAFT', 'FAILED'] } },
        select: { id: true },
      });
      const ids = pending.map((photo) => photo.id);
      if (ids.length > 0) {
        await tx.photo.updateMany({
          where: { id: { in: ids } },
          data: { status: 'REJECTED', rejectionReason: reason.slice(0, 200), moderatedById: actorUserId, moderatedAt: new Date() },
        });
        await tx.publicationQueue.updateMany({
          where: { photoId: { in: ids }, status: { in: ['WAITING', 'PROCESSING', 'FAILED'] } },
          data: { status: 'CANCELLED', finishedAt: new Date() },
        });
      }
      await this.activity.log(
        { action: 'USER_BLOCKED', userId: actorUserId, entityType: 'User', entityId: targetId, details: { reason, cancelledPhotos: ids.length } },
        tx,
      );
      return { user, cancelledPhotos: ids.length };
    });
  }

  async unblock(targetId: number, actorUserId: number): Promise<User> {
    const result = await this.prisma.user.updateMany({
      where: { id: targetId, isBlocked: true },
      data: { isBlocked: false, blockedAt: null, blockedReason: null },
    });
    if (result.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'USER_UNBLOCKED', userId: actorUserId, entityType: 'User', entityId: targetId });
    return this.prisma.user.findUniqueOrThrow({ where: { id: targetId } });
  }

  async markBotBlocked(telegramId: number): Promise<void> {
    await this.prisma.user.updateMany({ where: { telegramId: BigInt(telegramId) }, data: { botBlockedAt: new Date() } });
  }

  async getStats(userId: number): Promise<UserStats> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const queued = await this.prisma.photo.count({ where: { userId, status: { in: [...ACTIVE_PHOTO_STATUSES] } } });
    const rank = user.votesReceived > 0 ? (await this.prisma.user.count({ where: { votesReceived: { gt: user.votesReceived } } })) + 1 : null;
    return { user, queued, rank };
  }

  async list(page: number, pageSize: number): Promise<{ items: User[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ orderBy: { id: 'desc' }, skip: page * pageSize, take: pageSize }),
      this.prisma.user.count(),
    ]);
    return { items, total };
  }

  async topByVotes(limit: number): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { votesReceived: { gt: 0 }, isBlocked: false },
      orderBy: [{ votesReceived: 'desc' }, { photosPublished: 'desc' }, { id: 'asc' }],
      take: limit,
    });
  }
}
