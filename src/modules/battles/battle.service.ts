import { randomInt } from 'node:crypto';
import type { Battle, Duel, DuelSide, Photo, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError } from '../../lib/errors.js';
import { stripCustomEmoji } from '../../lib/entities-html.js';
import { channelPostLink, escapeHtml, formatDateTime, formatTime, truncate } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BotIdentity, ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import { buildDuelCollage } from '../duels/collage.js';
import { findActiveDuel } from '../payments/payment.service.js';
import { activeDuelKeyboard, closedDuelKeyboard } from '../duels/duel-post.js';
import { ALL_PHOTOS, anySlotFile, entriesOf, entryCount, inAnySlot, MAX_FINAL_SIZE, SIDES, sideNumber, voteList, votesOf } from '../duels/sides.js';
import { renderTemplate, roundName, stageValues, templateFor, type StagePoint, type TemplateKey } from '../duels/templates.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

type Db = PrismaClient | Prisma.TransactionClient;
type DuelWithPhotos = Duel & { photoA: Photo; photoB: Photo | null; photoC: Photo | null; photoD: Photo | null; battle: Battle };

/** Entries of a duel with their photos, in slot order. */
function photosOf(duel: { photoA: Photo; photoB: Photo | null; photoC: Photo | null; photoD: Photo | null }): { side: DuelSide; photo: Photo }[] {
  const all = { A: duel.photoA, B: duel.photoB, C: duel.photoC, D: duel.photoD };
  return SIDES.flatMap((side) => (all[side] ? [{ side, photo: all[side] }] : []));
}

/** Entries that compete in (or are waiting for) a battle. */
const ENTRY_STATUSES = ['PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER'] as const;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const ADMIN_ALERT_INTERVAL_MS = 30 * 60_000;
/** Admins are reminded once when a prepared duel post is not published within this time. */
const PUBLISH_REMINDER_MS = 10 * 60_000;

export interface BattleOptions {
  timeZone: string;
  /** Tiebreak reposts before the earlier entry wins a tie. */
  maxTiebreaks: number;
}

export interface ScheduleBattleInput {
  /** Optional: battles are named "Фотобатл #N" automatically. */
  title?: string;
  startsAt: Date;
  roundMinutes: number;
  /** Voting time of the final; null/undefined = same as roundMinutes. */
  finalMinutes?: number | null;
  tiebreakMinutes: number;
  /** Entries in the final post: 2 (a pair) up to 4 (one post with all finalists). */
  finalSize?: number;
  createdById: number | null;
}

export type PrepareOutcome = 'prepared' | 'skipped';

/** Fisher–Yates shuffle with a cryptographic RNG (pairings must not be predictable). */
export function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** The final: the round where all remaining entries fit in one post. */
export function isFinalRound(battle: Pick<Battle, 'finalSize'>, entriesInRound: number): boolean {
  return entriesInRound <= Math.max(2, battle.finalSize);
}

/** Voting time of a pair: tiebreak reposts, the final and regular rounds can differ. */
export function votingMinutes(battle: Pick<Battle, 'roundMinutes' | 'finalMinutes' | 'tiebreakMinutes' | 'finalSize'>, stage: number, entriesInRound: number): number {
  if (stage > 0) return battle.tiebreakMinutes;
  return isFinalRound(battle, entriesInRound) ? (battle.finalMinutes ?? battle.roundMinutes) : battle.roundMinutes;
}

/** When a pair published at `now` stops voting: the admin's round end if set, else its voting time. */
export function duelEnd(
  battle: Pick<Battle, 'roundMinutes' | 'finalMinutes' | 'tiebreakMinutes' | 'roundEndsAt' | 'currentRound' | 'finalSize'>,
  round: number,
  stage: number,
  entriesInRound: number,
  now: Date,
): Date {
  if (stage === 0 && battle.roundEndsAt && battle.currentRound === round && battle.roundEndsAt > now) return battle.roundEndsAt;
  return new Date(now.getTime() + votingMinutes(battle, stage, entriesInRound) * 60_000);
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

  /** The duel an entry is being voted on right now, and its number in it (1–4). */
  async activeDuelOf(photoId: number): Promise<{ duel: Duel; side: number } | null> {
    const active = await findActiveDuel(this.prisma, photoId);
    return active ? { duel: active.duel, side: sideNumber(active.side) } : null;
  }

  /**
   * Changes how many entries play in the final. When the current round already
   * fits in the new final (e.g. 3 entries left as "pair + bye") and nobody has
   * voted in it yet, the round is rebuilt as one group final post.
   */
  async setFinalSize(battleId: number, size: number, actorUserId: number | null): Promise<{ battle: Battle; rebuilt: boolean }> {
    if (!Number.isInteger(size) || size < 2 || size > MAX_FINAL_SIZE) throw new RangeError('Invalid final size');
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (!battle || (battle.status !== 'SCHEDULED' && battle.status !== 'RUNNING')) throw new DomainError('INVALID_STATE');

    let rebuild: Duel[] | null = null;
    if (battle.status === 'RUNNING' && battle.currentRound > 0) {
      const duels = await this.prisma.duel.findMany({ where: { battleId, round: battle.currentRound }, orderBy: { position: 'asc' } });
      const entries = duels.reduce((sum, duel) => sum + entryCount(duel), 0);
      // The final is already being played (a last pair, or a group post).
      if (entries <= 2 || duels.some((duel) => duel.photoCId !== null)) throw new DomainError('INVALID_STATE');
      if (entries <= size) {
        const real = duels.filter((duel) => duel.photoBId !== null);
        const voted = await this.prisma.duel.count({
          where: { id: { in: real.map((duel) => duel.id) }, OR: [{ votes: { some: {} } }, { paidVotes: { some: {} } }] },
        });
        if (voted > 0 || real.some((duel) => duel.status === 'FINISHED')) throw new DomainError('VOTING_STARTED');
        rebuild = duels;
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.battle.update({ where: { id: battleId }, data: { finalSize: size } });
      if (rebuild) {
        const ids = rebuild.flatMap((duel) => entriesOf(duel).map((entry) => entry.photoId));
        await tx.duel.deleteMany({ where: { id: { in: rebuild.map((duel) => duel.id) } } });
        await this.createRound(tx, battleId, battle.currentRound, ids, size);
      }
      await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Battle', entityId: battleId, details: { finalSize: size, rebuilt: !!rebuild } }, tx);
      return saved;
    });
    if (rebuild) {
      // Posts of the old pairs that are already in the channel are removed.
      await this.deleteMessages(rebuild.flatMap((duel) => [...(duel.messageId ? [duel.messageId] : []), ...duel.mediaMessageIds]));
      const entries = rebuild.reduce((sum, duel) => sum + entryCount(duel), 0);
      await this.notifications.notifyAdmins((l) => l.admin.finalRebuilt(entries));
      await this.prepareAnnouncement(await this.roundAnnouncement(updated, battle.currentRound, entries));
      await this.scheduler.triggerTick();
    }
    return { battle: updated, rebuilt: !!rebuild };
  }

  async entriesCount(battleId: number): Promise<number> {
    return this.prisma.photo.count({ where: { battleId, status: { in: [...ENTRY_STATUSES] } } });
  }

  async roundProgress(battleId: number, round: number): Promise<{ total: number; finished: number; ready: number }> {
    const [total, finished, ready] = await Promise.all([
      this.prisma.duel.count({ where: { battleId, round } }),
      this.prisma.duel.count({ where: { battleId, round, status: 'FINISHED' } }),
      this.prisma.duel.count({ where: { battleId, round, status: 'READY' } }),
    ]);
    return { total, finished, ready };
  }

  async schedule(input: ScheduleBattleInput, now: Date = new Date()): Promise<Battle> {
    const title = input.title?.trim() || this.locale.battle.defaultTitle((await this.prisma.battle.count()) + 1);
    if (title.length > 64) throw new RangeError('Battle title must be at most 64 characters');
    if (input.startsAt <= now) throw new RangeError('Battle must start in the future');
    if (input.roundMinutes < 5 || input.roundMinutes > 7 * 24 * 60) throw new RangeError('Invalid round duration');
    if (input.tiebreakMinutes < 1 || input.tiebreakMinutes > 24 * 60) throw new RangeError('Invalid tiebreak duration');
    if (input.finalMinutes != null && (input.finalMinutes < 5 || input.finalMinutes > 7 * 24 * 60)) throw new RangeError('Invalid final duration');
    const finalSize = input.finalSize ?? 2;
    if (!Number.isInteger(finalSize) || finalSize < 2 || finalSize > MAX_FINAL_SIZE) throw new RangeError('Invalid final size');

    const battle = await this.prisma.$transaction(async (tx) => {
      if (await tx.battle.findFirst({ where: { status: { in: ['SCHEDULED', 'RUNNING'] } } })) throw new DomainError('BATTLE_EXISTS');
      const created = await tx.battle.create({
        data: {
          title,
          startsAt: input.startsAt,
          roundMinutes: input.roundMinutes,
          finalMinutes: input.finalMinutes ?? null,
          tiebreakMinutes: input.tiebreakMinutes,
          finalSize,
          createdById: input.createdById,
        },
      });
      await this.activity.log({ action: 'BATTLE_CREATED', userId: input.createdById, entityType: 'Battle', entityId: created.id }, tx);
      return created;
    });
    await this.scheduler.scheduleTickAt(battle.startsAt, `battle-${battle.id}`);
    await this.prepareAnnouncement(
      await this.render('announce', {
        battle: battle.title,
        start: formatDateTime(battle.startsAt, this.options.timeZone, this.locale.intl),
        bot: `@${this.bot.username}`,
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
      const open = await tx.duel.findMany({ where: { battleId, status: { in: ['PENDING', 'READY', 'ACTIVE'] } } });
      await tx.duel.updateMany({ where: { battleId, status: { in: ['PENDING', 'READY', 'ACTIVE'] } }, data: { status: 'FINISHED', finishedAt: new Date() } });
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

    await this.remindUnpublished(now);

    const pending = await this.prisma.duel.findMany({
      where: { status: 'PENDING', battle: { status: 'RUNNING' } },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
      select: { id: true, stage: true },
    });
    for (const duel of pending) await this.scheduler.enqueueDuelPrepare(duel.id, duel.stage);
  }

  /** Start: shuffle accepted entries and create round 1. */
  async start(battleId: number): Promise<void> {
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.battle.updateMany({ where: { id: battleId, status: 'SCHEDULED' }, data: { status: 'RUNNING', startedAt: new Date() } });
      if (claimed.count === 0) return null;
      const { finalSize } = await tx.battle.findUniqueOrThrow({ where: { id: battleId }, select: { finalSize: true } });
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
      await this.createRound(tx, battleId, 1, shuffle(entries.map((entry) => entry.id)), finalSize);
      return { started: true as const, soleWinner: null, entries: entries.length };
    });
    if (!result) return;
    const battle = await this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
    if (!result.started) {
      await this.prepareAnnouncement(this.locale.battle.announceNoEntries(escapeHtml(battle.title)));
      return;
    }
    if (result.soleWinner) {
      await this.finishBattle(battleId, result.soleWinner);
      return;
    }
    await this.prepareAnnouncement(await this.roundAnnouncement(battle, 1, result.entries));
    await this.scheduler.triggerTick();
  }

  /**
   * Creates duels for a round; byes are finished immediately. When the remaining
   * entries fit in the final (2–4 by the battle's setting), they all go into one post.
   */
  private async createRound(tx: Prisma.TransactionClient, battleId: number, round: number, photoIds: number[], finalSize: number): Promise<void> {
    if (photoIds.length >= 3 && photoIds.length <= Math.min(finalSize, MAX_FINAL_SIZE)) {
      const [a, b, c, d] = photoIds;
      await tx.duel.create({ data: { battleId, round, position: 1, photoAId: a!, photoBId: b!, photoCId: c!, photoDId: d ?? null } });
      await tx.battle.update({ where: { id: battleId }, data: { currentRound: round, roundEndsAt: null } });
      if (round > 1) await this.activity.log({ action: 'BATTLE_ROUND_STARTED', entityType: 'Battle', entityId: battleId, details: { round, duels: 1, final: photoIds.length } }, tx);
      return;
    }
    const pairs = pairEntries(await this.latestGetsBye(tx, photoIds));
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
    await tx.battle.update({ where: { id: battleId }, data: { currentRound: round, roundEndsAt: null } });
    if (round > 1) await this.activity.log({ action: 'BATTLE_ROUND_STARTED', entityType: 'Battle', entityId: battleId, details: { round, duels: pairs.length } }, tx);
  }

  /**
   * Rule: with an odd number of entries, the entry submitted last advances without a vote.
   * It is moved to the end of the list, where pairEntries leaves it unpaired.
   */
  private async latestGetsBye(tx: Prisma.TransactionClient, photoIds: number[]): Promise<number[]> {
    if (photoIds.length % 2 === 0) return photoIds;
    const photos = await tx.photo.findMany({ where: { id: { in: photoIds } }, select: { id: true, confirmedAt: true, createdAt: true } });
    const submitted = (photo: (typeof photos)[number]): number => (photo.confirmedAt ?? photo.createdAt).getTime();
    const latest = photos.reduce((a, b) => (submitted(b) > submitted(a) || (submitted(b) === submitted(a) && b.id > a.id) ? b : a));
    return [...photoIds.filter((id) => id !== latest.id), latest.id];
  }

  /**
   * Prepares one duel stage for publication: the finished post (collage, or an
   * album for videos, with the admin-designed caption) is sent to every admin,
   * who publishes it in the channel. Called by the duel job (one at a time, paced).
   */
  async prepareDuel(duelId: number, stage: number): Promise<PrepareOutcome> {
    const duel = await this.prisma.duel.findUnique({ where: { id: duelId }, include: { ...ALL_PHOTOS, battle: true } });
    if (!duel || duel.status !== 'PENDING' || duel.stage !== stage || entryCount(duel) < 2 || duel.battle.status !== 'RUNNING') return 'skipped';
    const adminChats = await this.notifications.adminChatIds();
    if (adminChats.length === 0) throw new Error('No admins to publish duels: set ADMIN_IDS');

    const stageInfo = { round: duel.round, entriesInRound: await this.roundEntries(duel.battleId, duel.round), duel: duel.position, stage, finalSize: duel.battle.finalSize };
    // The pair is usually published right away; the end shown in the post is an estimate from now.
    const expectedEnd = duelEnd(duel.battle, duel.round, stage, stageInfo.entriesInRound, new Date());
    const caption = await this.render('duel', { battle: duel.battle.title, ...stageValues(this.locale, stageInfo), end: this.time(expectedEnd) }, stageInfo);

    await this.notifications.notifyAdmins((l) => l.admin.duelReady(stageValues(l, stageInfo).stage as string));
    let preparedFileUniqueId: string | null;
    try {
      preparedFileUniqueId = await this.sendPrepared(duel as DuelWithPhotos, caption, adminChats);
    } catch (error) {
      if (classifyTelegramError(error).kind === 'permanent') await this.alertAdmins(classifyTelegramError(error).description, duel.id);
      throw error;
    }
    const updated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: 'PENDING', stage },
      data: { status: 'READY', preparedFileUniqueId, readyAt: new Date(), remindedAt: null },
    });
    return updated.count ? 'prepared' : 'skipped';
  }

  /**
   * Sends the ready post to the admins. Photos → one collage (uploaded once, then
   * re-sent by file id so every copy has the same file_unique_id); videos → album.
   * Returns the collage's file_unique_id (null for albums, which are recognised by the entries' files).
   */
  private async sendPrepared(duel: DuelWithPhotos, caption: string, adminChats: number[]): Promise<string | null> {
    const photos = photosOf(duel).map((entry) => entry.photo);
    const isCollage = photos.every((photo) => photo.mediaType === 'PHOTO');
    const images: Buffer[] = [];
    if (isCollage) for (const photo of photos) images.push(await this.telegram.downloadFile(photo.fileId, MAX_MEDIA_BYTES));
    const collage = isCollage ? await buildDuelCollage(...images) : null;
    let html = caption;
    let collageRef: { fileId: string; uniqueId: string } | null = null;

    for (const chatId of adminChats) {
      const send = async (text: string) => {
        if (collage) {
          const sent = await this.telegram.sendPhoto(chatId, collageRef?.fileId ?? collage, { caption: text, parseMode: 'HTML' });
          const largest = sent.photo?.at(-1);
          if (!collageRef && largest) collageRef = { fileId: largest.file_id, uniqueId: largest.file_unique_id };
          return;
        }
        await this.telegram.sendMediaGroup(
          chatId,
          photos.map((photo, index) => ({ type: photo.mediaType === 'VIDEO' ? ('video' as const) : ('photo' as const), fileId: photo.fileId, ...(index === 0 ? { caption: text } : {}) })),
        );
      };
      try {
        await send(html);
      } catch (error) {
        // Premium emoji need the bot owner's Telegram Premium; without it send regular emoji.
        const classified = classifyTelegramError(error);
        if (classified.kind !== 'permanent' || !/emoji|entit/i.test(classified.description) || !html.includes('<tg-emoji')) throw error;
        this.logger.warn({ duelId: duel.id, error: classified.description }, 'Custom emoji rejected, preparing with regular emoji');
        html = stripCustomEmoji(html);
        await send(html);
      }
    }
    return collage ? (collageRef as { uniqueId: string } | null)?.uniqueId ?? null : null;
  }

  /**
   * Called for every new channel post. When it is an admin's copy of a prepared
   * duel (the same collage, or the entries' videos), the duel goes live: the bot
   * replies under it with the vote buttons and the voting timer starts.
   * Returns true when the post belongs to a duel.
   */
  async linkChannelPost(post: { messageId: number; fileUniqueIds: string[] }): Promise<boolean> {
    const ids = post.fileUniqueIds;
    if (ids.length === 0) return false;
    const byFiles = (status: 'READY' | 'ACTIVE') => ({
      status,
      OR: [{ preparedFileUniqueId: { in: ids } }, ...anySlotFile(ids)],
    });

    const duel = await this.prisma.duel.findFirst({ where: byFiles('READY'), include: { ...ALL_PHOTOS, battle: true }, orderBy: [{ round: 'asc' }, { position: 'asc' }] });
    if (!duel || entryCount(duel) < 2) return this.attachAlbumItem(post.messageId, byFiles('ACTIVE'));

    const settings = await this.settings.get();
    const stage = duel.stage;
    const entriesInRound = await this.roundEntries(duel.battleId, duel.round);
    const stageInfo = { round: duel.round, entriesInRound, duel: duel.position, stage, finalSize: duel.battle.finalSize };
    const now = new Date();
    const endsAt = duelEnd(duel.battle, duel.round, stage, entriesInRound, now);
    const buttonsText = await this.render('buttons', { ...stageValues(this.locale, stageInfo), end: this.time(endsAt) }, stageInfo);
    const buttonsOptions = {
      parseMode: 'HTML' as const,
      replyMarkup: activeDuelKeyboard(this.locale, { id: duel.id, stage, votes: voteList(duel) }, settings.paidVotesEnabled),
      replyToMessageId: post.messageId,
    };
    let buttons;
    try {
      buttons = await this.telegram.sendMessage(this.channel.id, buttonsText, buttonsOptions);
    } catch (error) {
      // The bot itself cannot use premium emoji in the channel: retry with regular ones.
      const classified = classifyTelegramError(error);
      if (classified.kind !== 'permanent' || !buttonsText.includes('<tg-emoji')) throw error;
      buttons = await this.telegram.sendMessage(this.channel.id, stripCustomEmoji(buttonsText), buttonsOptions);
    }
    const activated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: 'READY', stage },
      data: { status: 'ACTIVE', postedAt: now, endsAt, messageId: buttons.message_id, mediaMessageIds: [post.messageId] },
    });
    if (activated.count === 0) {
      // Another item of the same album won the race: keep only its buttons.
      await this.deleteMessages([buttons.message_id]);
      return this.attachAlbumItem(post.messageId, byFiles('ACTIVE'));
    }
    await this.scheduler.scheduleTickAt(endsAt, `duel-${duel.id}-${stage}`);

    const link = channelPostLink(this.channel, post.messageId);
    const ends = formatDateTime(endsAt, this.options.timeZone, this.locale.intl);
    await this.notifications.notifyAdmins((l) => l.admin.duelPublished({ stage: stageValues(l, stageInfo).stage as string, ends }));
    if (stage === 0) {
      for (const { photo } of photosOf(duel)) {
        const author = await this.prisma.user.findUnique({ where: { id: photo.userId } });
        if (author) await this.notifications.notifyUser(author, (l) => l.battle.entryPosted({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
      }
    }
    return true;
  }

  /**
   * Admin sets when the current round ends: pairs already voting and pairs
   * published later all stop at that time; then the next round starts.
   */
  async setRoundEnd(battleId: number, at: Date, actorUserId: number | null, now: Date = new Date()): Promise<{ battle: Battle; changed: number }> {
    if (at <= now) throw new DomainError('INVALID_STATE');
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (battle?.status !== 'RUNNING' || battle.currentRound === 0) throw new DomainError('INVALID_STATE');
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.battle.update({ where: { id: battleId }, data: { roundEndsAt: at } });
      const changed = await tx.duel.updateMany({ where: { battleId, round: battle.currentRound, status: 'ACTIVE', stage: 0 }, data: { endsAt: at } });
      await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Battle', entityId: battleId, details: { roundEndsAt: at.toISOString(), round: battle.currentRound } }, tx);
      return { battle: updated, changed: changed.count };
    });
    await this.scheduler.scheduleTickAt(at, `round-end-${battleId}-${battle.currentRound}-${at.getTime()}`);
    return result;
  }

  /** Pairs of the current round an admin may publish again (prepared or already in the channel). */
  async republishable(battleId: number, round: number): Promise<Duel[]> {
    return this.prisma.duel.findMany({
      where: { battleId, round, status: { in: ['READY', 'ACTIVE'] }, photoBId: { not: null } }, // photoB is set in every real (non-bye) duel
      orderBy: { position: 'asc' },
    });
  }

  /**
   * Undoes a wrong publication: the channel post and the buttons are removed, the
   * pair goes back to PENDING and its post is prepared for the admins again.
   * Votes already given are kept and shown on the new buttons.
   */
  async republish(duelId: number, actorUserId: number | null): Promise<boolean> {
    const duel = await this.prisma.duel.findUnique({ where: { id: duelId }, include: { battle: true } });
    if (!duel || duel.battle.status !== 'RUNNING' || !duel.photoBId || (duel.status !== 'READY' && duel.status !== 'ACTIVE')) return false;
    const reset = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: duel.status, stage: duel.stage },
      data: { status: 'PENDING', messageId: null, mediaMessageIds: [], postedAt: null, endsAt: null, readyAt: null, remindedAt: null, preparedFileUniqueId: null },
    });
    if (reset.count === 0) return false;
    await this.deleteMessages([...(duel.messageId ? [duel.messageId] : []), ...duel.mediaMessageIds]);
    await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Duel', entityId: duel.id, details: { republish: true, round: duel.round, position: duel.position } });
    await this.scheduler.enqueueDuelPrepare(duel.id, duel.stage);
    return true;
  }

  /** True when the files belong to a prepared duel waiting for publication. */
  async isPreparedPost(fileUniqueIds: string[]): Promise<boolean> {
    if (fileUniqueIds.length === 0) return false;
    const found = await this.prisma.duel.findFirst({
      where: {
        status: 'READY',
        OR: [{ preparedFileUniqueId: { in: fileUniqueIds } }, ...anySlotFile(fileUniqueIds)],
      },
      select: { id: true },
    });
    return !!found;
  }

  /** Remembers further album items of a live duel so the whole post can be removed later. */
  private async attachAlbumItem(messageId: number, where: Prisma.DuelWhereInput): Promise<boolean> {
    const active = await this.prisma.duel.findFirst({ where, orderBy: { id: 'desc' } });
    if (!active || active.mediaMessageIds.includes(messageId)) return !!active;
    await this.prisma.duel.update({ where: { id: active.id }, data: { mediaMessageIds: { push: messageId } } });
    return true;
  }

  /**
   * Decides a finished duel stage: the entry with most votes wins (pair or group
   * final). A tie for the first place is re-voted; after the last tiebreak the
   * earlier of the tied entries wins. Entries withdrawn meanwhile cannot win.
   */
  async closeDuel(duelId: number, stage: number): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const duel = await tx.duel.findUnique({ where: { id: duelId }, include: ALL_PHOTOS });
      if (!duel || duel.status !== 'ACTIVE' || duel.stage !== stage || entryCount(duel) < 2) return null;
      const contenders = photosOf(duel).filter(({ photo }) => photo.status === 'IN_BATTLE');
      const pool = contenders.length > 0 ? contenders : photosOf(duel);
      const top = Math.max(...pool.map(({ side }) => votesOf(duel, side)));
      const leaders = pool.filter(({ side }) => votesOf(duel, side) === top);
      if (leaders.length > 1 && duel.stage < this.options.maxTiebreaks) {
        const updated = await tx.duel.updateMany({
          where: { id: duelId, status: 'ACTIVE', stage },
          data: { status: 'PENDING', stage: stage + 1, votesA: 0, votesB: 0, votesC: 0, votesD: 0, endsAt: null },
        });
        return updated.count ? { kind: 'tiebreak' as const, duel } : null;
      }
      const winner = leaders.map((entry) => entry.photo).reduce((a, b) => earlierEntry(a, b));
      const losers = photosOf(duel)
        .map((entry) => entry.photo)
        .filter((photo) => photo.id !== winner.id);
      const finished = await tx.duel.updateMany({
        where: { id: duelId, status: 'ACTIVE', stage },
        data: { status: 'FINISHED', winnerPhotoId: winner.id, finishedAt: new Date() },
      });
      if (finished.count === 0) return null;
      await tx.photo.updateMany({ where: { id: { in: losers.map((photo) => photo.id) }, status: 'IN_BATTLE' }, data: { status: 'ELIMINATED' } });
      return { kind: 'finished' as const, duel, winner, losers };
    });
    if (!outcome) return;

    if (outcome.kind === 'tiebreak') {
      await this.closeButtons(outcome.duel, 'tie');
      await this.scheduler.enqueueDuelPrepare(duelId, stage + 1);
      return;
    }
    const { duel, winner, losers } = outcome;
    await this.closeButtons(duel, entriesOf(duel).find((entry) => entry.photoId === winner.id)?.side ?? 'tie');
    const postId = duel.mediaMessageIds[0] ?? duel.messageId;
    const link = postId ? channelPostLink(this.channel, postId) : '';
    const winnerUser = await this.prisma.user.findUnique({ where: { id: winner.userId } });
    if (winnerUser) await this.notifications.notifyUser(winnerUser, (l) => l.battle.duelWon({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
    for (const loser of losers) {
      const loserUser = await this.prisma.user.findUnique({ where: { id: loser.userId } });
      if (loserUser) await this.notifications.notifyUser(loserUser, (l) => l.battle.duelLost({ round: duel.round, link }), { parseMode: 'HTML', disablePreview: true });
    }
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
      await this.createRound(tx, battleId, battle.currentRound + 1, winners, battle.finalSize);
      return { final: undefined, battle, round: battle.currentRound + 1, entries: winners.length };
    });
    if (!next) return;
    if (next.final !== undefined) {
      if (next.final === null) await this.cancelEmpty(battleId);
      else await this.finishBattle(battleId, next.final);
      return;
    }
    await this.prepareAnnouncement(await this.roundAnnouncement(next.battle, next.round!, next.entries!));
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
    // The winner post is prepared for the admins, who publish it in the channel.
    const caption = await this.render('winner', { battle: finished.title, votes: winnerPhoto.votesCount });
    await this.notifications.notifyAdmins((l) => l.admin.announcementReady);
    for (const chatId of await this.notifications.adminChatIds()) {
      try {
        if (winnerPhoto.mediaType === 'VIDEO') await this.telegram.sendMediaGroup(chatId, [{ type: 'video', fileId: winnerPhoto.fileId, caption }]);
        else await this.telegram.sendPhoto(chatId, winnerPhoto.fileId, { caption, parseMode: 'HTML' });
      } catch (error) {
        this.logger.error({ err: error, battleId }, 'Failed to prepare the winner post');
      }
    }
    await this.notifications.notifyUser(winnerPhoto.user, (l) => l.battle.winnerDm(escapeHtml(finished.title)));
  }

  /**
   * Withdraws an entry from a running battle (deleted by author/admin):
   * its open duel is won by the opponent and the duel post is removed.
   */
  async forfeit(photoId: number): Promise<void> {
    const duel = await this.prisma.duel.findFirst({
      where: { status: { in: ['PENDING', 'READY', 'ACTIVE'] }, ...inAnySlot(photoId) },
    });
    if (!duel) return;
    // In a group final with more than two entries the others keep playing; the
    // withdrawn entry simply cannot win (see closeDuel).
    if (entryCount(duel) > 2) return;
    const opponent = duel.photoAId === photoId ? duel.photoBId : duel.photoAId;
    const updated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: { in: ['PENDING', 'READY', 'ACTIVE'] } },
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
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, activeDuelKeyboard(this.locale, { id: duel.id, stage: duel.stage, votes: voteList(duel) }, settings.paidVotesEnabled));
    } catch (error) {
      if (classifyTelegramError(error).kind !== 'not_modified') throw error;
    }
  }

  /** Link to the latest channel post of an entry, if it was published. */
  async entryPostLink(photoId: number): Promise<string | null> {
    const duel = await this.prisma.duel.findFirst({
      where: { messageId: { not: null }, ...inAnySlot(photoId) },
      orderBy: [{ round: 'desc' }],
    });
    const postId = duel?.mediaMessageIds[0] ?? duel?.messageId;
    return postId ? channelPostLink(this.channel, postId) : null;
  }

  private async closeButtons(duel: Duel, winner: DuelSide | 'tie'): Promise<void> {
    if (!duel.messageId) return;
    try {
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, closedDuelKeyboard(this.locale, { id: duel.id, stage: duel.stage, votes: voteList(duel) }, winner));
    } catch (error) {
      if (classifyTelegramError(error).kind !== 'not_modified') this.logger.warn({ err: error, duelId: duel.id }, 'Failed to close duel buttons');
    }
  }

  private async deleteMessages(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.telegram.deleteMessage(this.channel.id, id).catch((error: unknown) => this.logger.warn({ err: error, messageId: id }, 'Failed to delete duel post'));
    }
  }

  /** Renders a post from the admin's design (or the default text) in the channel language. */
  private async render(key: TemplateKey, values: Record<string, string | number>, point?: StagePoint): Promise<string> {
    return renderTemplate(templateFor(await this.settings.get(), this.locale, key, point), key, values);
  }

  private async roundAnnouncement(battle: Battle, round: number, entries: number): Promise<string> {
    const end = this.time(new Date(Date.now() + votingMinutes(battle, 0, entries) * 60_000));
    return this.render('round', { battle: battle.title, round, roundName: roundName(this.locale, round, entries, battle.finalSize), entries, end }, { round, entriesInRound: entries, finalSize: battle.finalSize });
  }

  /** "16:00" in the battle time zone. */
  private time(date: Date): string {
    return formatTime(date, this.options.timeZone, this.locale.intl);
  }

  /** Number of entries playing in a round (a bye counts once). */
  private async roundEntries(battleId: number, round: number): Promise<number> {
    const duels = await this.prisma.duel.findMany({ where: { battleId, round }, select: { photoAId: true, photoBId: true, photoCId: true, photoDId: true } });
    return duels.reduce((sum, duel) => sum + entryCount(duel), 0);
  }

  /** Prepared posts that nobody published for a while: remind the admins once. */
  private async remindUnpublished(now: Date): Promise<void> {
    const stale = await this.prisma.duel.findMany({
      where: { status: 'READY', remindedAt: null, readyAt: { lte: new Date(now.getTime() - PUBLISH_REMINDER_MS) } },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
    });
    for (const duel of stale) {
      const claimed = await this.prisma.duel.updateMany({ where: { id: duel.id, status: 'READY', remindedAt: null }, data: { remindedAt: now } });
      if (claimed.count === 0) continue;
      const finalSize = (await this.prisma.battle.findUnique({ where: { id: duel.battleId }, select: { finalSize: true } }))?.finalSize ?? 2;
      const stageInfo = { round: duel.round, entriesInRound: await this.roundEntries(duel.battleId, duel.round), duel: duel.position, stage: duel.stage, finalSize };
      await this.notifications.notifyAdmins((l) => l.admin.publishReminder(stageValues(l, stageInfo).stage as string));
    }
  }

  /** Channel announcements are prepared for the admins too: a short note, then the ready text to forward. */
  private async prepareAnnouncement(html: string): Promise<void> {
    await this.notifications.notifyAdmins((l) => l.admin.announcementReady);
    await this.notifications.notifyAdmins(() => html, { parseMode: 'HTML', disablePreview: true });
  }

  /** Permanent errors while preparing a duel post — alert admins at most every 30 minutes. */
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
