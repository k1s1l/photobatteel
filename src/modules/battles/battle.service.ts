import type { Battle, Photo, Prisma, PrismaClient, User } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError } from '../../lib/errors.js';
import { displayName, escapeHtml, formatDateTime, formatPhotoId } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BotIdentity, ChannelInfo, TelegramGateway } from '../contracts.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

type Db = PrismaClient | Prisma.TransactionClient;
const HOUR_MS = 60 * 60 * 1000;

export interface CreateBattleInput {
  title: string;
  theme: string | null;
  submissionHours: number;
  votingHours: number;
  isWeekly?: boolean;
  createdById: number | null;
}

/** Weekly battle: submissions Monday→Saturday, voting until shortly before the next one starts. */
export const WEEKLY_SUBMISSION_HOURS = 120;
export const WEEKLY_VOTING_HOURS = 47;

export class BattleService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly telegram: TelegramGateway,
    private readonly channel: ChannelInfo,
    private readonly bot: BotIdentity,
    private readonly locale: Locale,
    private readonly timeZone: string,
    private readonly logger: Logger,
  ) {}

  /** The battle currently accepting submissions, if any. */
  async getAcceptingBattle(db: Db = this.prisma, now: Date = new Date()): Promise<Battle | null> {
    return db.battle.findFirst({
      where: { status: 'ACTIVE', startsAt: { lte: now }, submissionsEndAt: { gt: now } },
      orderBy: { startsAt: 'desc' },
    });
  }

  /** The most recent battle that is accepting submissions or voting. */
  async getCurrent(): Promise<Battle | null> {
    return this.prisma.battle.findFirst({ where: { status: { in: ['ACTIVE', 'VOTING'] } }, orderBy: { startsAt: 'desc' } });
  }

  async findById(id: number): Promise<Battle | null> {
    return this.prisma.battle.findUnique({ where: { id } });
  }

  async list(limit: number): Promise<Battle[]> {
    return this.prisma.battle.findMany({ orderBy: { id: 'desc' }, take: limit });
  }

  async create(input: CreateBattleInput, now: Date = new Date()): Promise<Battle> {
    const title = input.title.trim();
    if (!title || title.length > 64) throw new RangeError('Battle title must be 1-64 characters');
    if (input.theme && input.theme.length > 200) throw new RangeError('Battle theme must be at most 200 characters');
    if (input.submissionHours < 1 || input.votingHours < 0) throw new RangeError('Invalid battle duration');

    const battle = await this.prisma.$transaction(async (tx) => {
      const active = await tx.battle.findFirst({ where: { status: 'ACTIVE' } });
      if (active) throw new DomainError('BATTLE_EXISTS');
      const submissionsEndAt = new Date(now.getTime() + input.submissionHours * HOUR_MS);
      const created = await tx.battle.create({
        data: {
          title,
          theme: input.theme?.trim() || null,
          isWeekly: input.isWeekly ?? false,
          startsAt: now,
          submissionsEndAt,
          endsAt: new Date(submissionsEndAt.getTime() + input.votingHours * HOUR_MS),
          createdById: input.createdById,
        },
      });
      await this.activity.log({ action: 'BATTLE_CREATED', userId: input.createdById, entityType: 'Battle', entityId: created.id }, tx);
      return created;
    });

    await this.postToChannel(
      this.locale.battle.announceStart({
        title: escapeHtml(battle.title),
        theme: battle.theme ? escapeHtml(battle.theme) : null,
        submissionsEnd: formatDateTime(battle.submissionsEndAt, this.timeZone),
        end: formatDateTime(battle.endsAt, this.timeZone),
        botUsername: this.bot.username,
      }),
    );
    return battle;
  }

  /** Creates the weekly battle when the feature is on and nothing is running. */
  async createWeeklyIfEnabled(now: Date = new Date()): Promise<Battle | null> {
    const settings = await this.settings.get();
    if (!settings.weeklyBattlesEnabled) return null;
    if (await this.prisma.battle.findFirst({ where: { status: 'ACTIVE' } })) return null;
    const number = (await this.prisma.battle.count({ where: { isWeekly: true } })) + 1;
    return this.create(
      {
        title: this.locale.battle.weeklyTitle(number),
        theme: null,
        submissionHours: WEEKLY_SUBMISSION_HOURS,
        votingHours: WEEKLY_VOTING_HOURS,
        isWeekly: true,
        createdById: null,
      },
      now,
    );
  }

  /** Advances battle lifecycles. Runs every minute. */
  async tick(now: Date = new Date()): Promise<void> {
    const closing = await this.prisma.battle.findMany({ where: { status: 'ACTIVE', submissionsEndAt: { lte: now } } });
    for (const battle of closing) await this.startVoting(battle, null);

    const ending = await this.prisma.battle.findMany({ where: { status: 'VOTING', endsAt: { lte: now } } });
    for (const battle of ending) await this.finish(battle.id, null);
  }

  /** Admin action: stop accepting photos now; voting continues until endsAt. */
  async closeSubmissions(battleId: number, adminUserId: number): Promise<Battle> {
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (!battle || battle.status !== 'ACTIVE') throw new DomainError('INVALID_STATE');
    const now = new Date();
    const updated = await this.prisma.battle.update({
      where: { id: battleId },
      data: { submissionsEndAt: now, endsAt: battle.endsAt < now ? now : battle.endsAt },
    });
    await this.startVoting(updated, adminUserId);
    return updated;
  }

  /** Finishes a battle and selects the winner: most votes, earliest publication wins ties. */
  async finish(battleId: number, adminUserId: number | null): Promise<{ battle: Battle; winner: (Photo & { user: User }) | null }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.battle.updateMany({
        where: { id: battleId, status: { in: ['ACTIVE', 'VOTING'] } },
        data: { status: 'FINISHED', finishedAt: now },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      const winner = await tx.photo.findFirst({
        where: { battleId, status: 'PUBLISHED' },
        orderBy: [{ votesCount: 'desc' }, { publishedAt: 'asc' }, { id: 'asc' }],
        include: { user: true },
      });
      const battle = await tx.battle.update({
        where: { id: battleId },
        data: { winnerPhotoId: winner?.id ?? null, ...(adminUserId ? { endsAt: now } : {}) },
      });
      await this.activity.log(
        { action: 'BATTLE_FINISHED', userId: adminUserId, entityType: 'Battle', entityId: battleId, details: { winnerPhotoId: winner?.id ?? null } },
        tx,
      );
      return { battle, winner };
    });

    const { battle, winner } = result;
    if (winner) {
      const id = formatPhotoId(winner.id);
      await this.postToChannel(
        this.locale.battle.announceWinner({ title: escapeHtml(battle.title), winner: escapeHtml(displayName(winner.user)), id, votes: winner.votesCount }),
      );
      await this.notifications.notifyUser(winner.user.telegramId, this.locale.battle.winnerDm({ title: escapeHtml(battle.title), id, votes: winner.votesCount }));
    } else {
      await this.postToChannel(this.locale.battle.announceNoWinner(escapeHtml(battle.title)));
    }
    return result;
  }

  async cancel(battleId: number, adminUserId: number): Promise<Battle> {
    const updated = await this.prisma.battle.updateMany({
      where: { id: battleId, status: { in: ['ACTIVE', 'VOTING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    if (updated.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'BATTLE_CANCELLED', userId: adminUserId, entityType: 'Battle', entityId: battleId });
    return this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
  }

  async leaderboard(battleId: number, limit: number): Promise<(Photo & { user: User })[]> {
    return this.prisma.photo.findMany({
      where: { battleId, status: 'PUBLISHED' },
      orderBy: [{ votesCount: 'desc' }, { publishedAt: 'asc' }, { id: 'asc' }],
      include: { user: true },
      take: limit,
    });
  }

  async participantsCount(battleId: number): Promise<number> {
    return this.prisma.photo.count({ where: { battleId, status: { in: ['PENDING_MODERATION', 'QUEUED', 'PUBLISHED'] } } });
  }

  private async startVoting(battle: Battle, adminUserId: number | null): Promise<void> {
    const updated = await this.prisma.battle.updateMany({ where: { id: battle.id, status: 'ACTIVE' }, data: { status: 'VOTING' } });
    if (updated.count === 0) return;
    await this.activity.log({ action: 'BATTLE_VOTING_STARTED', userId: adminUserId, entityType: 'Battle', entityId: battle.id });
    await this.postToChannel(this.locale.battle.announceVoting({ title: escapeHtml(battle.title), end: formatDateTime(battle.endsAt, this.timeZone) }));
  }

  private async postToChannel(text: string): Promise<void> {
    try {
      await this.telegram.sendMessage(this.channel.id, text, { parseMode: 'HTML', disablePreview: true });
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to post battle announcement to the channel');
    }
  }
}
