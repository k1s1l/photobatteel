import type { PrismaClient } from '../../generated/prisma/client.js';

export interface BotStats {
  users: number;
  newUsers24h: number;
  blockedUsers: number;
  received: number;
  waiting: number;
  pending: number;
  inBattle: number;
  rejected: number;
  deleted: number;
  battlesFinished: number;
  duelsFinished: number;
  freeVotes: number;
  paidVotes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class StatsService {
  constructor(private readonly prisma: PrismaClient) {}

  async botStats(now: Date = new Date()): Promise<BotStats> {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const [users, newUsers24h, blockedUsers, byStatus, received, battlesFinished, duelsFinished, freeVotes, paid] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { isBlocked: true } }),
      this.prisma.photo.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.photo.count({ where: { confirmedAt: { not: null } } }),
      this.prisma.battle.count({ where: { status: 'FINISHED' } }),
      this.prisma.duel.count({ where: { status: 'FINISHED', photoBId: { not: null } } }),
      this.prisma.duelVote.count(),
      this.prisma.paidVote.aggregate({ _sum: { amount: true } }),
    ]);
    const count = (status: string) => byStatus.find((row) => row.status === status)?._count?._all ?? 0;
    return {
      users,
      newUsers24h,
      blockedUsers,
      received,
      waiting: count('ACCEPTED'),
      pending: count('PENDING_MODERATION'),
      inBattle: count('IN_BATTLE'),
      rejected: count('REJECTED'),
      deleted: count('DELETED'),
      battlesFinished,
      duelsFinished,
      freeVotes,
      paidVotes: paid._sum.amount ?? 0,
    };
  }

  async pendingModeration(): Promise<number> {
    return this.prisma.photo.count({ where: { status: 'PENDING_MODERATION' } });
  }
}
