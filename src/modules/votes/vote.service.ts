import type { PrismaClient, User } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError, isUniqueViolation } from '../../lib/errors.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import { buildVoteKeyboard } from '../publications/channel-post.js';
import type { SettingsService } from '../settings/settings.service.js';

export interface VoteResult {
  voted: boolean;
  votes: number;
}

/** "🔥 Support" votes on channel posts: one vote per user per photo, pressing again withdraws it. */
export class VoteService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly scheduler: JobScheduler,
    private readonly telegram: TelegramGateway,
    private readonly channel: ChannelInfo,
    private readonly locale: Locale,
  ) {}

  async toggle(photoId: number, voter: User): Promise<VoteResult> {
    const settings = await this.settings.get();
    if (!settings.votingEnabled) throw new DomainError('VOTING_DISABLED');
    if (voter.isBlocked) throw new DomainError('USER_BLOCKED');

    let result: VoteResult;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const photo = await tx.photo.findUnique({ where: { id: photoId }, select: { id: true, userId: true, status: true } });
        if (!photo || photo.status !== 'PUBLISHED') throw new DomainError('NOT_FOUND');
        if (photo.userId === voter.id) throw new DomainError('SELF_VOTE');

        const removed = await tx.vote.deleteMany({ where: { photoId, userId: voter.id } });
        const delta = removed.count > 0 ? -1 : 1;
        if (delta > 0) await tx.vote.create({ data: { photoId, userId: voter.id } });
        const updated = await tx.photo.update({ where: { id: photoId }, data: { votesCount: { increment: delta } }, select: { votesCount: true } });
        await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: delta } } });
        return { voted: delta > 0, votes: updated.votesCount };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent press already registered the vote.
      const photo = await this.prisma.photo.findUniqueOrThrow({ where: { id: photoId }, select: { votesCount: true } });
      return { voted: true, votes: photo.votesCount };
    }
    await this.scheduler.scheduleVoteRefresh(photoId);
    return result;
  }

  /** Updates the counter on the channel button. Called by a debounced background job. */
  async refreshButton(photoId: number): Promise<void> {
    const photo = await this.prisma.photo.findUnique({ where: { id: photoId }, include: { publication: true } });
    if (!photo?.publication || photo.publication.removedAt || photo.status !== 'PUBLISHED') return;
    const settings = await this.settings.get();
    const markup = settings.votingEnabled ? buildVoteKeyboard(this.locale, photo.id, photo.votesCount) : undefined;
    try {
      await this.telegram.editMessageReplyMarkup(this.channel.id, photo.publication.messageId, markup);
    } catch (error) {
      if (classifyTelegramError(error).kind !== 'not_modified') throw error;
    }
  }
}
