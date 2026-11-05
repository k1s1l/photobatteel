import type { DuelSide, PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError, isUniqueViolation } from '../../lib/errors.js';
import type { ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import type { SettingsService } from '../settings/settings.service.js';

export interface DuelVoteResult {
  /** The side the user now supports, or null when the vote was withdrawn. */
  side: DuelSide | null;
  votesA: number;
  votesB: number;
}

const MEMBERSHIP_TTL_MS = 10 * 60_000;

/**
 * Free votes in duels: one per user per duel stage. Pressing the same side
 * again withdraws the vote; pressing the other side moves it.
 */
export class DuelVoteService {
  private readonly members = new Map<number, number>(); // telegram id → verified until (ms)

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly scheduler: JobScheduler,
    private readonly telegram: TelegramGateway,
    private readonly channel: ChannelInfo,
  ) {}

  async vote(duelId: number, stage: number, side: DuelSide, voter: User, now: Date = new Date()): Promise<DuelVoteResult> {
    if (voter.isBlocked) throw new DomainError('USER_BLOCKED');
    const settings = await this.settings.get();
    if (settings.subscribersOnly && !(await this.isSubscriber(Number(voter.telegramId)))) throw new DomainError('NOT_SUBSCRIBED');

    let result: DuelVoteResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const duel = await tx.duel.findUnique({ where: { id: duelId }, include: { photoA: true, photoB: true } });
        if (!duel?.photoB || duel.status !== 'ACTIVE' || duel.stage !== stage || (duel.endsAt && duel.endsAt <= now)) {
          throw new DomainError('VOTING_CLOSED');
        }
        const target = side === 'A' ? duel.photoA : duel.photoB;
        if (target.userId === voter.id) throw new DomainError('SELF_VOTE');

        const existing = await tx.duelVote.findUnique({ where: { duelId_stage_userId: { duelId, stage, userId: voter.id } } });
        const counters: Record<DuelSide, number> = { A: 0, B: 0 };
        let newSide: DuelSide | null = side;
        if (!existing) {
          await tx.duelVote.create({ data: { duelId, stage, userId: voter.id, side } });
          counters[side] += 1;
        } else if (existing.side === side) {
          await tx.duelVote.delete({ where: { id: existing.id } });
          counters[side] -= 1;
          newSide = null;
        } else {
          await tx.duelVote.update({ where: { id: existing.id }, data: { side } });
          counters[existing.side] -= 1;
          counters[side] += 1;
        }
        const updated = await tx.duel.update({
          where: { id: duelId },
          data: { votesA: { increment: counters.A }, votesB: { increment: counters.B } },
          select: { votesA: true, votesB: true },
        });
        for (const [photo, delta] of [
          [duel.photoA, counters.A],
          [duel.photoB, counters.B],
        ] as const) {
          if (delta === 0) continue;
          await tx.photo.update({ where: { id: photo.id }, data: { votesCount: { increment: delta } } });
          await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: delta } } });
        }
        return { side: newSide, ...updated };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent press already registered this vote.
      const duel = await this.prisma.duel.findUniqueOrThrow({ where: { id: duelId }, select: { votesA: true, votesB: true } });
      return { side, ...duel };
    }
    await this.scheduler.scheduleVoteRefresh(duelId);
    return result;
  }

  private async isSubscriber(telegramId: number): Promise<boolean> {
    const until = this.members.get(telegramId);
    if (until && until > Date.now()) return true;
    let member = false;
    try {
      member = await this.telegram.isChatMember(this.channel.id, telegramId);
    } catch {
      // "user not found" in the channel and similar answers mean not subscribed.
      member = false;
    }
    if (member) this.members.set(telegramId, Date.now() + MEMBERSHIP_TTL_MS);
    else this.members.delete(telegramId);
    return member;
  }
}
