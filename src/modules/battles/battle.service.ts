import { randomInt } from 'node:crypto';
import type { Battle, Duel, Photo, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError } from '../../lib/errors.js';
import { stripCustomEmoji } from '../../lib/entities-html.js';
import { channelPostLink, escapeHtml, formatDateTime, truncate } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BotIdentity, ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import { buildDuelCollage } from '../duels/collage.js';
import { findActiveDuel } from '../payments/payment.service.js';
import { activeDuelKeyboard, closedDuelKeyboard, renderDuelCaption } from '../duels/duel-post.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

type Db = PrismaClient | Prisma.TransactionClient;
type DuelWithPhotos = Duel & { photoA: Photo; photoB: Photo | null; battle: Battle };

/** Entries that compete in (or are waiting for) a battle. */
const ENTRY_STATUSES = ['PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER'] as const;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const ADMIN_ALERT_INTERVAL_MS = 30 * 60_000;

export interface BattleOptions {
  timeZone: string;
  /** Tiebreak reposts before the earlier entry wins a tie. */
  maxTiebreaks: number;
}

export interface ScheduleBattleInput {
  title: string;
  startsAt: Date;
  roundMinutes: number;
  tiebreakMinutes: number;
  createdById: number | null;
}

export type PostOutcome = 'posted' | 'skipped';

/** Fisher–Yates shuffle with a cryptographic RNG (pairings must not be predictable). */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Pairs entries in order; with an odd count the last entry gets a bye. */
export function pairEntries(ids: readonly number[]): { a: number; b: number | null }[] {
  const pairs: { a: number; b: number | null }[] = [];
  for (let i = 0; i < ids.length; i += 2) pairs.push({ a: ids[i]!, b: ids[i + 1] ?? null });
  return pairs;
}

/**
 * Tournament engine. Entries are collected until `startsAt`; then every round
 * pairs the remaining entries into duels posted to the channel. A tie is
 * re-voted for `tiebreakMinutes` (votes start from zero); after `maxTiebreaks`
 * ties the earlier entry advances. Winners of a round meet in the next one
 * until a single winner remains.
 *
 * The engine is driven by `tick()` (every 30 s) and by duel post jobs;
 * every state change is guarded by its expected previous state, so repeated
 * or concurrent ticks are harmless.
 */
export class BattleService {
  private lastAdminAlert = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly telegram: TelegramGateway,
    private readonly scheduler: JobScheduler,
    private readonly channel: ChannelInfo,
    private readonly bot: BotIdentity,
    private readonly locale: Locale,
    private readonly logger: Logger,
    private readonly options: BattleOptions,
  ) {}

  /** Language of channel posts (also used for admin previews of the duel design). */
  get channelLocale(): Locale {
    return this.locale;
  }

  /** The battle currently accepting entries (scheduled, start time not reached). */
  async getOpen(db: Db = this.prisma, now: Date = new Date()): Promise<Battle | null> {
    return db.battle.findFirst({ where: { status: 'SCHEDULED', startsAt: { gt: now } }, orderBy: { startsAt: 'asc' } });
  }

  /** The scheduled or running battle, if any. */
  async getCurrent(): Promise<Battle | null> {
    return this.prisma.battle.findFirst({ where: { status: { in: ['SCHEDULED', 'RUNNING'] } }, orderBy: { startsAt: 'asc' } });
  }

  async findById(id: number): Promise<Battle | null> {
    return this.prisma.battle.findUnique({ where: { id } });
  }

  async list(limit: number): Promise<Battle[]> {
    return this.prisma.battle.findMany({ orderBy: { id: 'desc' }, take: limit });
  }

  async getDuel(id: number): Promise<Duel | null> {
    return this.prisma.duel.findUnique({ where: { id } });
  }

  /** The duel an entry is being voted on right now, and which side (1 or 2) it is. */
  async activeDuelOf(photoId: number): Promise<{ duel: Duel; side: 1 | 2 } | null> {
    const active = await findActiveDuel(this.prisma, photoId);
    return active ? { duel: active.duel, side: active.side === 'A' ? 1 : 2 } : null;
  }

  async entriesCount(battleId: number): Promise<number> {
    return this.prisma.photo.count({ where: { battleId, status: { in: [...ENTRY_STATUSES] } } });
  }

  async roundProgress(battleId: number, round: number): Promise<{ total: number; finished: number }> {
    const [total, finished] = await Promise.all([
      this.prisma.duel.count({ where: { battleId, round } }),
      this.prisma.duel.count({ where: { battleId, round, status: 'FINISHED' } }),
    ]);
    return { total, finished };
  }

  async schedule(input: ScheduleBattleInput, now: Date = new Date()): Promise<Battle> {
    const title = input.title.trim();
    if (!title || title.length > 64) throw new RangeError('Battle title must be 1-64 characters');
    if (input.startsAt <= now) throw new RangeError('Battle must start in the future');
    if (input.roundMinutes < 5 || input.roundMinutes > 7 * 24 * 60) throw new RangeError('Invalid round duration');
    if (input.tiebreakMinutes < 1 || input.tiebreakMinutes > 24 * 60) throw new RangeError('Invalid tiebreak duration');

    const battle = await this.prisma.$transaction(async (tx) => {
      if (await tx.battle.findFirst({ where: { status: { in: ['SCHEDULED', 'RUNNING'] } } })) throw new DomainError('BATTLE_EXISTS');
      const created = await tx.battle.create({
        data: { title, startsAt: input.startsAt, roundMinutes: input.roundMinutes, tiebreakMinutes: input.tiebreakMinutes, createdById: input.createdById },
      });
      await this.activity.log({ action: 'BATTLE_CREATED', userId: input.createdById, entityType: 'Battle', entityId: created.id }, tx);
      return created;
    });
    await this.scheduler.scheduleTickAt(battle.startsAt, `battle-${battle.id}`);
    await this.postText(
      this.locale.battle.announceScheduled({
        title: escapeHtml(battle.title),
        start: formatDateTime(battle.startsAt, this.options.timeZone, this.locale.intl),
        botUsername: this.bot.username,
      }),
    );
    return battle;
  }

  async cancel(battleId: number, adminUserId: number): Promise<Battle> {
    const duels = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.battle.updateMany({
        where: { id: battleId, status: { in: ['SCHEDULED', 'RUNNING'] } },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.photo.updateMany({ where: { battleId, status: { in: ['ACCEPTED', 'IN_BATTLE', 'PENDING_MODERATION'] } }, data: { status: 'CANCELLED' } });
      const open = await tx.duel.findMany({ where: { battleId, status: { in: ['PENDING', 'ACTIVE'] } } });
      await tx.duel.updateMany({ where: { battleId, status: { in: ['PENDING', 'ACTIVE'] } }, data: { status: 'FINISHED', finishedAt: new Date() } });
      await this.activity.log({ action: 'BATTLE_CANCELLED', userId: adminUserId, entityType: 'Battle', entityId: battleId }, tx);
      return open;
    });
    for (const duel of duels) if (duel.messageId) await this.closeButtons(duel, 'tie');
    return this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
  }

  /** Drives all battles forward. Safe to run repeatedly and concurrently. */
  async tick(now: Date = new Date()): Promise<void> {
    const due = await this.prisma.battle.findMany({ where: { status: 'SCHEDULED', startsAt: { lte: now } } });
    for (const battle of due) await this.start(battle.id);

    const expired = await this.prisma.duel.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, select: { id: true, stage: true } });
    for (const duel of expired) await this.closeDuel(duel.id, duel.stage);

    const running = await this.prisma.battle.findMany({ where: { status: 'RUNNING' } });
    for (const battle of running) await this.advance(battle.id);

    const pending = await this.prisma.duel.findMany({
      where: { status: 'PENDING', battle: { status: 'RUNNING' } },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
      select: { id: true, stage: true },
    });
    for (const duel of pending) await this.scheduler.enqueueDuelPost(duel.id, duel.stage);
  }

  /** Start: shuffle accepted entries and create round 1. */
  async start(battleId: number): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.battle.updateMany({ where: { id: battleId, status: 'SCHEDULED' }, data: { status: 'RUNNING', startedAt: new Date() } });
      if (claimed.count === 0) return null;
      // Entries still waiting for moderation when the battle starts do not take part.
      await tx.photo.updateMany({ where: { battleId, status: 'PENDING_MODERATION' }, data: { status: 'CANCELLED' } });
      const entries = await tx.photo.findMany({ where: { battleId, status: 'ACCEPTED' }, select: { id: true } });
      if (entries.length === 0) {
        await tx.battle.update({ where: { id: battleId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
        return { started: false as const };
      }
      await tx.photo.updateMany({ where: { battleId, status: 'ACCEPTED' }, data: { status: 'IN_BATTLE' } });
      await this.activity.log({ action: 'BATTLE_STARTED', entityType: 'Battle', entityId: battleId, details: { entries: entries.length } }, tx);
      if (entries.length === 1) return { started: true as const, soleWinner: entries[0]!.id, entries: 1 };
      await this.createRound(tx, battleId, 1, shuffle(entries.map((entry) => entry.id)));
      return { started: true as const, soleWinner: null, entries: entries.length };
    });
    if (!result) return;
    const battle = await this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
    if (!result.started) {
      await this.postText(this.locale.battle.announceNoEntries(escapeHtml(battle.title)));
      return;
    }
    if (result.soleWinner) {
      await this.finishBattle(battleId, result.soleWinner);
      return;
    }
    await this.postText(this.locale.battle.announceRound({ title: escapeHtml(battle.title), round: 1, entries: result.entries }));
    await this.scheduler.triggerTick();
  }

  /** Creates duels for a round; byes are finished immediately. */
  private async createRound(tx: Prisma.TransactionClient, battleId: number, round: number, photoIds: number[]): Promise<void> {
    const pairs = pairEntries(photoIds);
    const now = new Date();
    for (const [index, pair] of pairs.entries()) {
      await tx.duel.create({
        data: {
          battleId,
          round,
          position: index + 1,
          photoAId: pair.a,
          photoBId: pair.b,
          ...(pair.b === null ? { status: 'FINISHED', winnerPhotoId: pair.a, finishedAt: now } : {}),
        },
      });
    }
    await tx.battle.update({ where: { id: battleId }, data: { currentRound: round } });
    if (round > 1) await this.activity.log({ action: 'BATTLE_ROUND_STARTED', entityType: 'Battle', entityId: battleId, details: { round, duels: pairs.length } }, tx);
  }

  /** Publishes one duel stage. Called by the duel post job (one at a time, paced). */
  async postDuel(duelId: number, stage: number): Promise<PostOutcome> {
    const duel = await this.prisma.duel.findUnique({ where: { id: duelId }, include: { photoA: true, photoB: true, battle: true } });
    if (!duel || duel.status !== 'PENDING' || duel.stage !== stage || !duel.photoB || duel.battle.status !== 'RUNNING') return 'skipped';

    const settings = await this.settings.get();
    const template = settings.duelTemplate ?? this.locale.duel.defaultTemplate;
    const caption = renderDuelCaption(template, this.locale, { battleTitle: duel.battle.title, round: duel.round, position: duel.position, stage });
    const keyboard = activeDuelKeyboard(this.locale, { id: duel.id, stage, votesA: 0, votesB: 0 }, settings.paidVotesEnabled);

    let messageId: number;
    let mediaMessageIds: number[] = [];
    try {
      ({ messageId, mediaMessageIds } = await this.sendDuel(duel as DuelWithPhotos, caption, keyboard));
    } catch (error) {
      const classified = classifyTelegramError(error);
      if (classified.kind === 'permanent') await this.alertAdmins(classified.description, duel.id);
      throw error;
    }

    const minutes = stage === 0 ? duel.battle.roundMinutes : duel.battle.tiebreakMinutes;
    const now = new Date();
    const endsAt = new Date(now.getTime() + minutes * 60_000);
    const activated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: 'PENDING', stage },
      data: { status: 'ACTIVE', postedAt: now, endsAt, messageId, mediaMessageIds },
    });
    if (activated.count === 0) {
      // Withdrawn while posting: remove the post again.
      await this.deleteMessages([messageId, ...mediaMessageIds]);
      return 'skipped';
    }
    await this.scheduler.scheduleTickAt(endsAt, `duel-${duel.id}-${stage}`);
    if (stage === 0) {
      const link = channelPostLink(this.channel, messageId);
      for (const photo of [duel.photoA, duel.photoB]) {
        const author = await this.prisma.user.findUnique({ where: { id: photo.userId } });
        if (author) await this.notifications.notifyUser(author, (l) => l.battle.entryPosted({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
      }
    }
    return 'posted';
  }

  /** Photos → one collage with buttons; anything with a video → album + buttons message under it. */
  private async sendDuel(duel: DuelWithPhotos, caption: string, keyboard: ReturnType<typeof activeDuelKeyboard>) {
    const photoB = duel.photoB!;
    const send = async (html: string) => {
      if (duel.photoA.mediaType === 'PHOTO' && photoB.mediaType === 'PHOTO') {
        const [first, second] = await Promise.all([
          this.telegram.downloadFile(duel.photoA.fileId, MAX_MEDIA_BYTES),
          this.telegram.downloadFile(photoB.fileId, MAX_MEDIA_BYTES),
        ]);
        const collage = await buildDuelCollage(first, second);
        const sent = await this.telegram.sendPhoto(this.channel.id, collage, { caption: html, parseMode: 'HTML', replyMarkup: keyboard });
        return { messageId: sent.message_id, mediaMessageIds: [] as number[] };
      }
      const album = await this.telegram.sendMediaGroup(this.channel.id, [
        { type: duel.photoA.mediaType === 'VIDEO' ? 'video' : 'photo', fileId: duel.photoA.fileId },
        { type: photoB.mediaType === 'VIDEO' ? 'video' : 'photo', fileId: photoB.fileId },
      ]);
      const sent = await this.telegram.sendMessage(this.channel.id, html, { parseMode: 'HTML', replyMarkup: keyboard, replyToMessageId: album[0] });
      return { messageId: sent.message_id, mediaMessageIds: album };
    };
    try {
      return await send(caption);
    } catch (error) {
      // Premium emoji in channels need a Fragment username for the bot; fall back to regular emoji.
      const classified = classifyTelegramError(error);
      if (classified.kind === 'permanent' && /emoji|entit/i.test(classified.description) && caption.includes('<tg-emoji')) {
        this.logger.warn({ duelId: duel.id, error: classified.description }, 'Custom emoji rejected, posting with regular emoji');
        return send(stripCustomEmoji(caption));
      }
      throw error;
    }
  }

  /** Decides a finished duel stage: winner, or a tiebreak repost. */
  async closeDuel(duelId: number, stage: number): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const duel = await tx.duel.findUnique({ where: { id: duelId }, include: { photoA: true, photoB: true } });
      if (!duel || duel.status !== 'ACTIVE' || duel.stage !== stage || !duel.photoB) return null;
      if (duel.votesA === duel.votesB && duel.stage < this.options.maxTiebreaks) {
        const updated = await tx.duel.updateMany({
          where: { id: duelId, status: 'ACTIVE', stage },
          data: { status: 'PENDING', stage: stage + 1, votesA: 0, votesB: 0, endsAt: null },
        });
        return updated.count ? { kind: 'tiebreak' as const, duel } : null;
      }
      let winner: Photo;
      if (duel.votesA !== duel.votesB) winner = duel.votesA > duel.votesB ? duel.photoA : duel.photoB;
      else winner = earlierEntry(duel.photoA, duel.photoB);
      const loser = winner.id === duel.photoA.id ? duel.photoB : duel.photoA;
      const finished = await tx.duel.updateMany({
        where: { id: duelId, status: 'ACTIVE', stage },
        data: { status: 'FINISHED', winnerPhotoId: winner.id, finishedAt: new Date() },
      });
      if (finished.count === 0) return null;
      await tx.photo.updateMany({ where: { id: loser.id, status: 'IN_BATTLE' }, data: { status: 'ELIMINATED' } });
      return { kind: 'finished' as const, duel, winner, loser };
    });
    if (!outcome) return;

    if (outcome.kind === 'tiebreak') {
      await this.closeButtons(outcome.duel, 'tie');
      await this.scheduler.enqueueDuelPost(duelId, stage + 1);
      return;
    }
    const { duel, winner, loser } = outcome;
    await this.closeButtons(duel, winner.id === duel.photoAId ? 'a' : 'b');
    const link = duel.messageId ? channelPostLink(this.channel, duel.messageId) : '';
    const [winnerUser, loserUser] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: winner.userId } }),
      this.prisma.user.findUnique({ where: { id: loser.userId } }),
    ]);
    if (winnerUser) await this.notifications.notifyUser(winnerUser, (l) => l.battle.duelWon({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
    if (loserUser) await this.notifications.notifyUser(loserUser, (l) => l.battle.duelLost({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
  }

  /** When every duel of the current round is finished: next round, or the final result. */
  async advance(battleId: number): Promise<void> {
    const next = await this.prisma.$transaction(async (tx) => {
      const battle = await tx.battle.findUnique({ where: { id: battleId } });
      if (battle?.status !== 'RUNNING' || battle.currentRound === 0) return null;
      const duels = await tx.duel.findMany({ where: { battleId, round: battle.currentRound }, orderBy: { position: 'asc' } });
      if (duels.length === 0 || duels.some((duel) => duel.status !== 'FINISHED')) return null;
      const winnerIds = duels.map((duel) => duel.winnerPhotoId).filter((id): id is number => id !== null);
      // Entries deleted between rounds do not advance.
      const stillIn = new Set(
        (await tx.photo.findMany({ where: { id: { in: winnerIds }, status: 'IN_BATTLE' }, select: { id: true } })).map((photo) => photo.id),
      );
      const winners = winnerIds.filter((id) => stillIn.has(id));
      if (winners.length <= 1) return { final: winners[0] ?? null, battle };
      const claimed = await tx.battle.updateMany({ where: { id: battleId, currentRound: battle.currentRound }, data: { currentRound: battle.currentRound + 1 } });
      if (claimed.count === 0) return null;
      await this.createRound(tx, battleId, battle.currentRound + 1, winners);
      return { final: undefined, battle, round: battle.currentRound + 1, entries: winners.length };
    });
    if (!next) return;
    if (next.final !== undefined) {
      if (next.final === null) await this.cancelEmpty(battleId);
      else await this.finishBattle(battleId, next.final);
      return;
    }
    await this.postText(this.locale.battle.announceRound({ title: escapeHtml(next.battle.title), round: next.round!, entries: next.entries! }));
    await this.scheduler.triggerTick();
  }

  private async cancelEmpty(battleId: number): Promise<void> {
    await this.prisma.battle.updateMany({ where: { id: battleId, status: 'RUNNING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  }

  private async finishBattle(battleId: number, winnerPhotoId: number): Promise<void> {
    const finished = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.battle.updateMany({ where: { id: battleId, status: 'RUNNING' }, data: { status: 'FINISHED', winnerPhotoId, finishedAt: new Date() } });
      if (updated.count === 0) return null;
      await tx.photo.update({ where: { id: winnerPhotoId }, data: { status: 'WINNER' } });
      await this.activity.log({ action: 'BATTLE_FINISHED', entityType: 'Battle', entityId: battleId, details: { winnerPhotoId } }, tx);
      return tx.battle.findUniqueOrThrow({ where: { id: battleId }, include: { winnerPhoto: { include: { user: true } } } });
    });
    if (!finished?.winnerPhoto) return;
    const { winnerPhoto } = finished;
    const caption = this.locale.battle.announceWinner({ title: escapeHtml(finished.title), votes: winnerPhoto.votesCount });
    try {
      if (winnerPhoto.mediaType === 'VIDEO') {
        const [albumId] = await this.telegram.sendMediaGroup(this.channel.id, [{ type: 'video', fileId: winnerPhoto.fileId }]);
        await this.telegram.sendMessage(this.channel.id, caption, { parseMode: 'HTML', ...(albumId ? { replyToMessageId: albumId } : {}) });
      } else {
        await this.telegram.sendPhoto(this.channel.id, winnerPhoto.fileId, { caption, parseMode: 'HTML' });
      }
    } catch (error) {
      this.logger.error({ err: error, battleId }, 'Failed to announce the winner');
    }
    await this.notifications.notifyUser(winnerPhoto.user, (l) => l.battle.winnerDm(escapeHtml(finished.title)));
  }

  /**
   * Withdraws an entry from a running battle (deleted by author/admin):
   * its open duel is won by the opponent and the duel post is removed.
   */
  async forfeit(photoId: number): Promise<void> {
    const duel = await this.prisma.duel.findFirst({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ photoAId: photoId }, { photoBId: photoId }] },
    });
    if (!duel) return;
    const opponent = duel.photoAId === photoId ? duel.photoBId : duel.photoAId;
    const updated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: 'FINISHED', winnerPhotoId: opponent, finishedAt: new Date() },
    });
    if (updated.count === 0) return;
    await this.deleteMessages([...(duel.messageId ? [duel.messageId] : []), ...duel.mediaMessageIds]);
    await this.scheduler.triggerTick();
  }

  /** Current counts on the channel buttons (debounced job). */
  async refreshButtons(duelId: number): Promise<void> {
    const duel = await this.prisma.duel.findUnique({ where: { id: duelId } });
    if (!duel?.messageId || duel.status !== 'ACTIVE') return;
    const settings = await this.settings.get();
    try {
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, activeDuelKeyboard(this.locale, duel, settings.paidVotesEnabled));
    } catch (error) {
      if (classifyTelegramError(error).kind !== 'not_modified') throw error;
    }
  }

  /** Link to the latest channel post of an entry, if it was posted. */
  async entryPostLink(photoId: number): Promise<string | null> {
    const duel = await this.prisma.duel.findFirst({
      where: { messageId: { not: null }, OR: [{ photoAId: photoId }, { photoBId: photoId }] },
      orderBy: [{ round: 'desc' }],
    });
    return duel?.messageId ? channelPostLink(this.channel, duel.messageId) : null;
  }

  private async closeButtons(duel: Duel, winner: 'a' | 'b' | 'tie'): Promise<void> {
    if (!duel.messageId) return;
    try {
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, closedDuelKeyboard(this.locale, duel, winner));
    } catch (error) {
      if (classifyTelegramError(error).kind !== 'not_modified') this.logger.warn({ err: error, duelId: duel.id }, 'Failed to close duel buttons');
    }
  }

  private async deleteMessages(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.telegram.deleteMessage(this.channel.id, id).catch((error: unknown) => this.logger.warn({ err: error, messageId: id }, 'Failed to delete duel post'));
    }
  }

  private async postText(html: string): Promise<void> {
    try {
      await this.telegram.sendMessage(this.channel.id, html, { parseMode: 'HTML', disablePreview: true });
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to post a battle announcement');
    }
  }

  /** Permanent posting errors (e.g. lost channel rights) — alert admins at most every 30 minutes. */
  private async alertAdmins(description: string, duelId: number): Promise<void> {
    await this.activity.log({ action: 'DUEL_POST_FAILED', entityType: 'Duel', entityId: duelId, details: { error: description } });
    if (Date.now() - this.lastAdminAlert < ADMIN_ALERT_INTERVAL_MS) return;
    this.lastAdminAlert = Date.now();
    await this.notifications.notifyAdmins((l) => l.admin.duelPostFailed(escapeHtml(truncate(description, 300))));
  }
}

/** Tie rule after all tiebreaks: the entry confirmed earlier advances. */
function earlierEntry(a: Photo, b: Photo): Photo {
  const timeA = (a.confirmedAt ?? a.createdAt).getTime();
  const timeB = (b.confirmedAt ?? b.createdAt).getTime();
  if (timeA !== timeB) return timeA < timeB ? a : b;
  return a.id < b.id ? a : b;
}
