import type { DuelSide, PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError, isUniqueViolation } from '../../lib/errors.js';
import type { ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import type { SettingsService } from '../settings/settings.service.js';
import { ALL_PHOTOS, entryCount, PHOTO_ID_FIELD, SIDES, VOTE_FIELD, VOTE_SELECT, type DuelVotes } from './sides.js';

export interface DuelVoteResult extends DuelVotes {
  /** The side the user now supports, or null when the vote was withdrawn. */
  side: DuelSide | null;
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
        const duel = await tx.duel.findUnique({ where: { id: duelId }, include: ALL_PHOTOS });
        if (!duel || entryCount(duel) < 2 || duel.status !== 'ACTIVE' || duel.stage !== stage || (duel.endsAt && duel.endsAt <= now)) {
          throw new DomainError('VOTING_CLOSED');
        }
        const photos = { A: duel.photoA, B: duel.photoB, C: duel.photoC, D: duel.photoD, E: duel.photoE, F: duel.photoF };
        const target = photos[side];
        if (!target || duel[PHOTO_ID_FIELD[side]] === null) throw new DomainError('VOTING_CLOSED');
        if (target.userId === voter.id) throw new DomainError('SELF_VOTE');

        const existing = await tx.duelVote.findUnique({ where: { duelId_stage_userId: { duelId, stage, userId: voter.id } } });
        const counters: Record<DuelSide, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
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
        const data = Object.fromEntries(SIDES.filter((s) => counters[s] !== 0).map((s) => [VOTE_FIELD[s], { increment: counters[s] }]));
        const updated = await tx.duel.update({ where: { id: duelId }, data, select: VOTE_SELECT });
        for (const s of SIDES) {
          const photo = photos[s];
          if (counters[s] === 0 || !photo) continue;
          await tx.photo.update({ where: { id: photo.id }, data: { votesCount: { increment: counters[s] } } });
          await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: counters[s] } } });
        }
        return { side: newSide, ...updated };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent press already registered this vote.
      const duel = await this.prisma.duel.findUniqueOrThrow({ where: { id: duelId }, select: VOTE_SELECT });
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
