import type { PrismaClient } from '../../generated/prisma/client.js';

export interface BotStats {
  users: number;
  newUsers24h: number;
  blockedUsers: number;
  received: number;
  published: number;
  waiting: number;
  pending: number;
  rejected: number;
  failed: number;
  deleted: number;
  published24h: number;
  votes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class StatsService {
  constructor(private readonly prisma: PrismaClient) {}

  async botStats(now: Date = new Date()): Promise<BotStats> {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const [users, newUsers24h, blockedUsers, byStatus, received, published24h, votes] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { isBlocked: true } }),
      this.prisma.photo.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.photo.count({ where: { confirmedAt: { not: null } } }),
      this.prisma.publication.count({ where: { publishedAt: { gte: dayAgo } } }),
      this.prisma.vote.count(),
    ]);
    const count = (status: string) => byStatus.find((row) => row.status === status)?._count?._all ?? 0;
    return {
      users,
      newUsers24h,
      blockedUsers,
      received,
      // "Published" counts every photo that reached the channel, even if later deleted.
      published: await this.prisma.publication.count(),
      waiting: count('QUEUED'),
      pending: count('PENDING_MODERATION'),
      rejected: count('REJECTED'),
      failed: count('FAILED'),
      deleted: count('DELETED'),
      published24h,
      votes,
    };
  }

  async queueCounters(): Promise<{ queued: number; pending: number }> {
    const [queued, pending] = await Promise.all([
      this.prisma.photo.count({ where: { status: 'QUEUED' } }),
      this.prisma.photo.count({ where: { status: 'PENDING_MODERATION' } }),
    ]);
    return { queued, pending };
  }
}
