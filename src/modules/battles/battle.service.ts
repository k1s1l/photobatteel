import { randomInt } from 'node:crypto';
import type { Battle, Duel, DuelSide, DuelStatus, Photo, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { DomainError } from '../../lib/errors.js';
import { isNarrowText, stripCustomEmoji } from '../../lib/entities-html.js';
import { channelPostLink, escapeHtml, formatDateTime, formatTime, truncate } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { BotIdentity, ChannelInfo, JobScheduler, TelegramGateway } from '../contracts.js';
import { buildDuelCollage } from '../duels/collage.js';
import { findActiveDuel } from '../payments/payment.service.js';
import { activeDuelKeyboard, closedDuelKeyboard } from '../duels/duel-post.js';
import { ALL_PHOTOS, anySlotFile, entriesOf, entryCount, inAnySlot, MAX_FINAL_SIZE, PHOTO_ID_FIELD, SIDES, sideNumber, VOTE_FIELD, voteList, votesOf, ZERO_VOTES } from '../duels/sides.js';
import { renderTemplate, roundName, stageValues, templateFor, type StagePoint, type TemplateKey } from '../duels/templates.js';
import { isFinalRound, takenSpots, type FinalSpotService } from '../final-spots/final-spot.service.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';

type Db = PrismaClient | Prisma.TransactionClient;
type DuelWithPhotos = Duel & { photoA: Photo; photoB: Photo | null; photoC: Photo | null; photoD: Photo | null; photoE: Photo | null; photoF: Photo | null; battle: Battle };

/** Entries of a duel with their photos, in slot order. */
function photosOf(duel: { photoA: Photo; photoB: Photo | null; photoC: Photo | null; photoD: Photo | null; photoE: Photo | null; photoF: Photo | null }): { side: DuelSide; photo: Photo }[] {
  const all = { A: duel.photoA, B: duel.photoB, C: duel.photoC, D: duel.photoD, E: duel.photoE, F: duel.photoF };
  return SIDES.flatMap((side) => (all[side] ? [{ side, photo: all[side] }] : []));
}

/** Entries that compete in (or are waiting for) a battle. */
const ENTRY_STATUSES = ['PENDING_MODERATION', 'ACCEPTED', 'IN_BATTLE', 'ELIMINATED', 'WINNER'] as const;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const ADMIN_ALERT_INTERVAL_MS = 30 * 60_000;
/** Admins are reminded once when a prepared duel post is not published within this time. */
const PUBLISH_REMINDER_MS = 10 * 60_000;
/** A pair waiting for a card transfer stays open 5 minutes at a time, at most 30 minutes after "I paid". */
const TRANSFER_HOLD_STEP_MS = 5 * 60_000;
const TRANSFER_HOLD_MAX_MS = 30 * 60_000;

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

export { isFinalRound };

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
  private finalSpots: FinalSpotService | null = null;

  /** Bought places in the final are refunded through this service (set after construction). */
  attachFinalSpots(service: FinalSpotService): void {
    this.finalSpots = service;
  }

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
    const taken = await takenSpots(this.prisma, battleId);
    if (size + taken > MAX_FINAL_SIZE) throw new DomainError('FINAL_SPOTS_TAKEN', { taken });

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

    let refund: number[] = [];
    const updated = await this.prisma.$transaction(async (tx) => {
      let saved = await tx.battle.update({ where: { id: battleId }, data: { finalSize: size } });
      if (rebuild) {
        const spots = await this.takeSpotsIntoFinal(tx, battleId);
        refund = spots.refund;
        const ids = [...rebuild.flatMap((duel) => entriesOf(duel).map((entry) => entry.photoId)), ...spots.photoIds];
        const finalSize = Math.min(MAX_FINAL_SIZE, Math.max(size, ids.length));
        if (finalSize !== size) saved = await tx.battle.update({ where: { id: battleId }, data: { finalSize } });
        await tx.duel.deleteMany({ where: { id: { in: rebuild.map((duel) => duel.id) } } });
        await this.createRound(tx, battleId, battle.currentRound, spots.photoIds.length > 0 ? shuffle(ids) : ids, finalSize);
      }
      await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Battle', entityId: battleId, details: { finalSize: size, rebuilt: !!rebuild } }, tx);
      return saved;
    });
    if (refund.length > 0) await this.finalSpots?.refundUnused(refund);
    if (rebuild) {
      // Posts of the old pairs that are already in the channel are removed.
      await this.deleteMessages(rebuild.flatMap((duel) => [...(duel.messageId ? [duel.messageId] : []), ...duel.mediaMessageIds]));
      const entries = await this.roundEntries(battleId, battle.currentRound);
      const auto = (await this.settings.get()).autoPublish;
      await this.notifications.notifyAdmins((l) => l.admin.finalRebuilt(entries, auto));
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

  /**
   * Moves the start of a scheduled battle (e.g. more time to collect photos).
   * Admins get a ready post about the new time for the channel.
   */
  async reschedule(battleId: number, startsAt: Date, actorUserId: number | null, now: Date = new Date()): Promise<Battle> {
    if (startsAt <= now) throw new RangeError('Battle must start in the future');
    const updated = await this.prisma.battle.updateMany({ where: { id: battleId, status: 'SCHEDULED' }, data: { startsAt } });
    if (updated.count === 0) throw new DomainError('INVALID_STATE');
    const battle = await this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
    await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Battle', entityId: battleId, details: { startsAt: startsAt.toISOString() } });
    // The tick at the old time finds nothing to start; this one starts the battle on time.
    await this.scheduler.scheduleTickAt(startsAt, `battle-${battle.id}-${startsAt.getTime()}`);
    await this.prepareAnnouncement(
      this.locale.battle.startMoved({ title: escapeHtml(battle.title), start: formatDateTime(startsAt, this.options.timeZone, this.locale.intl), bot: `@${this.bot.username}` }),
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
    const unused = await this.prisma.finalSpot.findMany({ where: { battleId, refundedAt: null, usedAt: null }, select: { id: true } });
    if (unused.length > 0) await this.finalSpots?.refundUnused(unused.map((spot) => spot.id));
    return this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
  }

  /** Drives all battles forward. Safe to run repeatedly and concurrently. */
  async tick(now: Date = new Date()): Promise<void> {
    const due = await this.prisma.battle.findMany({ where: { status: 'SCHEDULED', startsAt: { lte: now } } });
    for (const battle of due) await this.start(battle.id);

    const expired = await this.prisma.duel.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, select: { id: true, stage: true } });
    for (const duel of expired) {
      if (await this.holdForTransfer(duel.id, now)) continue;
      await this.closeDuel(duel.id, duel.stage);
    }

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
    await this.prepareByePost(battle, 1);
    await this.scheduler.triggerTick();
  }

  /**
   * Creates duels for a round; byes are finished immediately. When the remaining
   * entries fit in the final (2–4 by the battle's setting), they all go into one post.
   */
  private async createRound(tx: Prisma.TransactionClient, battleId: number, round: number, photoIds: number[], finalSize: number): Promise<void> {
    if (photoIds.length >= 3 && photoIds.length <= Math.min(finalSize, MAX_FINAL_SIZE)) {
      const [a, b, c, d, e, f] = photoIds;
      await tx.duel.create({
        data: { battleId, round, position: 1, photoAId: a!, photoBId: b!, photoCId: c!, photoDId: d ?? null, photoEId: e ?? null, photoFId: f ?? null },
      });
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
    const auto = (await this.settings.get()).autoPublish;
    const adminChats = auto ? [this.channel.id] : await this.notifications.adminChatIds();
    if (adminChats.length === 0) throw new Error('No admins to publish duels: set ADMIN_IDS');

    const stageInfo = { round: duel.round, entriesInRound: await this.roundEntries(duel.battleId, duel.round), duel: duel.position, stage, finalSize: duel.battle.finalSize };
    // The pair is usually published right away; the end shown in the post is an estimate from now.
    const expectedEnd = duelEnd(duel.battle, duel.round, stage, stageInfo.entriesInRound, new Date());
    const caption = await this.render('duel', { battle: duel.battle.title, ...stageValues(this.locale, stageInfo), end: this.time(expectedEnd) }, stageInfo);

    if (!auto) await this.notifications.notifyAdmins((l) => l.admin.duelReady(stageValues(l, stageInfo).stage as string));
    let prepared: { uniqueId: string | null; messageIds: number[] };
    try {
      prepared = await this.sendPrepared(duel as DuelWithPhotos, caption, adminChats);
    } catch (error) {
      if (classifyTelegramError(error).kind === 'permanent') await this.alertAdmins(classifyTelegramError(error).description, duel.id);
      throw error;
    }
    const updated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: 'PENDING', stage },
      data: { status: 'READY', preparedFileUniqueId: prepared.uniqueId, readyAt: new Date(), remindedAt: null },
    });
    if (!updated.count) return 'skipped';
    // Auto mode: the post is already in the channel — the pair goes live right away.
    if (auto && prepared.messageIds.length > 0) {
      const ready = await this.prisma.duel.findUniqueOrThrow({ where: { id: duel.id }, include: { ...ALL_PHOTOS, battle: true } });
      await this.activate(ready, prepared.messageIds[0]!, prepared.messageIds.slice(1));
    }
    return 'prepared';
  }

  /**
   * Sends the ready post to the admins. Photos → one collage (uploaded once, then
   * re-sent by file id so every copy has the same file_unique_id); videos → album.
   * Returns the collage's file_unique_id (null for albums, which are recognised by the entries' files).
   */
  private async sendPrepared(duel: DuelWithPhotos, caption: string, adminChats: number[]): Promise<{ uniqueId: string | null; messageIds: number[] }> {
    const photos = photosOf(duel).map((entry) => entry.photo);
    const isCollage = photos.every((photo) => photo.mediaType === 'PHOTO');
    const images: Buffer[] = [];
    if (isCollage) for (const photo of photos) images.push(await this.telegram.downloadFile(photo.fileId, MAX_MEDIA_BYTES));
    const collage = isCollage ? await buildDuelCollage(...images) : null;
    let html = caption;
    let collageRef: { fileId: string; uniqueId: string } | null = null;
    let messageIds: number[] = [];

    for (const chatId of adminChats) {
      const send = async (text: string) => {
        if (collage) {
          const sent = await this.telegram.sendPhoto(chatId, collageRef?.fileId ?? collage, { caption: text, parseMode: 'HTML' });
          const largest = sent.photo?.at(-1);
          if (!collageRef && largest) collageRef = { fileId: largest.file_id, uniqueId: largest.file_unique_id };
          messageIds = [sent.message_id];
          return;
        }
        messageIds = await this.telegram.sendMediaGroup(
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
        await this.emojiRejected('duel', classified.description);
        html = stripCustomEmoji(html);
        await send(html);
      }
    }
    return { uniqueId: collage ? ((collageRef as { uniqueId: string } | null)?.uniqueId ?? null) : null, messageIds };
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
    const activated = await this.activate(duel, post.messageId, []);
    return activated || this.attachAlbumItem(post.messageId, byFiles('ACTIVE'));
  }

  /**
   * The duel's post is in the channel: the bot replies under it with the vote
   * buttons and the voting timer starts. False when another post won the race.
   */
  private async activate(duel: DuelWithPhotos, postMessageId: number, extraMessageIds: number[]): Promise<boolean> {
    const auto = (await this.settings.get()).autoPublish;
    const post = { messageId: postMessageId };
    const settings = await this.settings.get();
    const stage = duel.stage;
    const entriesInRound = await this.roundEntries(duel.battleId, duel.round);
    const stageInfo = { round: duel.round, entriesInRound, duel: duel.position, stage, finalSize: duel.battle.finalSize };
    const now = new Date();
    const endsAt = duelEnd(duel.battle, duel.round, stage, entriesInRound, now);
    const buttonsText = await this.render('buttons', { ...stageValues(this.locale, stageInfo), end: this.time(endsAt) }, stageInfo);
    const stacked = isNarrowText(buttonsText);
    const buttonsOptions = {
      parseMode: 'HTML' as const,
      replyMarkup: activeDuelKeyboard(this.locale, { id: duel.id, stage, votes: voteList(duel), stacked, endsAt: this.time(endsAt) }, settings.paidVotesEnabled),
      replyToMessageId: post.messageId,
    };
    let buttons;
    try {
      buttons = await this.telegram.sendMessage(this.channel.id, buttonsText, buttonsOptions);
    } catch (error) {
      // The bot itself cannot use premium emoji in the channel: retry with regular ones.
      const classified = classifyTelegramError(error);
      if (classified.kind !== 'permanent' || !buttonsText.includes('<tg-emoji')) throw error;
      await this.emojiRejected('buttons', classified.description);
      buttons = await this.telegram.sendMessage(this.channel.id, stripCustomEmoji(buttonsText), buttonsOptions);
    }
    const activated = await this.prisma.duel.updateMany({
      where: { id: duel.id, status: 'READY', stage },
      data: { status: 'ACTIVE', postedAt: now, endsAt, messageId: buttons.message_id, mediaMessageIds: [post.messageId, ...extraMessageIds], stackedButtons: stacked },
    });
    if (activated.count === 0) {
      // Another item of the same album won the race: keep only its buttons.
      await this.deleteMessages([buttons.message_id]);
      return false;
    }
    await this.scheduler.scheduleTickAt(endsAt, `duel-${duel.id}-${stage}`);

    const link = channelPostLink(this.channel, post.messageId);
    const ends = formatDateTime(endsAt, this.options.timeZone, this.locale.intl);
    if (!auto) await this.notifications.notifyAdmins((l) => l.admin.duelPublished({ stage: stageValues(l, stageInfo).stage as string, ends }));
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
    for (const duel of await this.prisma.duel.findMany({ where: { battleId, round: battle.currentRound, status: 'ACTIVE' }, select: { id: true } })) {
      await this.scheduler.scheduleVoteRefresh(duel.id);
    }
    return result;
  }

  /** Open pairs of the current round (for the admin's vote corrections). */
  async openDuels(battleId: number): Promise<Duel[]> {
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (battle?.status !== 'RUNNING') return [];
    return this.prisma.duel.findMany({
      where: { battleId, round: battle.currentRound, status: { not: 'FINISHED' }, photoBId: { not: null } },
      orderBy: { position: 'asc' },
    });
  }

  /**
   * Admin correction: adds (or with a negative number removes) votes for one
   * entry of an open pair, e.g. a payment that came outside the bot. Never below zero.
   * Returns the votes the entry has now.
   */
  async adjustVotes(duelId: number, side: DuelSide, delta: number, actorUserId: number | null): Promise<number> {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) throw new RangeError('Invalid vote change');
    const result = await this.prisma.$transaction(async (tx) => {
      const duel = await tx.duel.findUnique({ where: { id: duelId } });
      const photoId = duel?.[PHOTO_ID_FIELD[side]];
      if (!duel || duel.status === 'FINISHED' || !photoId) throw new DomainError('INVALID_STATE');
      const current = votesOf(duel, side);
      const applied = Math.max(delta, -current);
      if (applied !== 0) {
        await tx.duel.update({ where: { id: duelId }, data: { [VOTE_FIELD[side]]: { increment: applied } } });
        const photo = await tx.photo.update({ where: { id: photoId }, data: { votesCount: { increment: applied } } });
        await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: applied } } });
        await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Duel', entityId: duelId, details: { side, votes: applied } }, tx);
      }
      return current + applied;
    });
    await this.scheduler.scheduleVoteRefresh(duelId);
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
  async closeDuel(duelId: number, stage: number, options: { force?: boolean } = {}): Promise<void> {
    // Forced by an admin: also pairs not published yet, and no tiebreak — a tie goes to the earlier entry.
    const open: DuelStatus[] = options.force ? ['PENDING', 'READY', 'ACTIVE'] : ['ACTIVE'];
    const outcome = await this.prisma.$transaction(async (tx) => {
      const duel = await tx.duel.findUnique({ where: { id: duelId }, include: ALL_PHOTOS });
      if (!duel || !open.includes(duel.status) || duel.stage !== stage || entryCount(duel) < 2) return null;
      const contenders = photosOf(duel).filter(({ photo }) => photo.status === 'IN_BATTLE');
      const pool = contenders.length > 0 ? contenders : photosOf(duel);
      const top = Math.max(...pool.map(({ side }) => votesOf(duel, side)));
      const leaders = pool.filter(({ side }) => votesOf(duel, side) === top);
      if (leaders.length > 1 && duel.stage < this.options.maxTiebreaks && !options.force) {
        const updated = await tx.duel.updateMany({
          where: { id: duelId, status: 'ACTIVE', stage },
          data: { status: 'PENDING', stage: stage + 1, ...ZERO_VOTES, endsAt: null },
        });
        return updated.count ? { kind: 'tiebreak' as const, duel } : null;
      }
      const winner = leaders.map((entry) => entry.photo).reduce((a, b) => earlierEntry(a, b));
      const losers = photosOf(duel)
        .map((entry) => entry.photo)
        .filter((photo) => photo.id !== winner.id);
      const finished = await tx.duel.updateMany({
        where: { id: duelId, status: { in: open }, stage },
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

  /**
   * Admin "finish now": every open pair of the current round is decided by the
   * votes it has right now (no tiebreaks, no waiting for payments). In the final
   * this finishes the battle; otherwise the next round starts.
   */
  async finishRoundNow(battleId: number, actorUserId: number | null): Promise<{ battle: Battle; wasFinal: boolean }> {
    const battle = await this.prisma.battle.findUnique({ where: { id: battleId } });
    if (battle?.status !== 'RUNNING' || battle.currentRound === 0) throw new DomainError('INVALID_STATE');
    const wasFinal = isFinalRound(battle, await this.roundEntries(battleId, battle.currentRound));
    const open = await this.prisma.duel.findMany({ where: { battleId, round: battle.currentRound, status: { not: 'FINISHED' } } });
    for (const duel of open) await this.closeDuel(duel.id, duel.stage, { force: true });
    await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Battle', entityId: battleId, details: { finishedRound: battle.currentRound, wasFinal } });
    await this.advance(battleId);
    return { battle: await this.prisma.battle.findUniqueOrThrow({ where: { id: battleId } }), wasFinal };
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
      // The final is next: bought places with a photo join it, places without one are refunded.
      let ids = winners;
      let finalSize = battle.finalSize;
      let refund: number[] = [];
      if (winners.length <= Math.max(2, battle.finalSize)) {
        const spots = await this.takeSpotsIntoFinal(tx, battleId);
        refund = spots.refund;
        if (spots.photoIds.length > 0) {
          ids = shuffle([...winners, ...spots.photoIds]);
          finalSize = Math.min(MAX_FINAL_SIZE, Math.max(battle.finalSize, ids.length));
          await tx.battle.update({ where: { id: battleId }, data: { finalSize } });
        }
      }
      if (ids.length <= 1) return { final: ids[0] ?? null, battle, refund };
      const claimed = await tx.battle.updateMany({ where: { id: battleId, currentRound: battle.currentRound }, data: { currentRound: battle.currentRound + 1 } });
      if (claimed.count === 0) return null;
      await this.createRound(tx, battleId, battle.currentRound + 1, ids, finalSize);
      return { final: undefined, battle: { ...battle, finalSize }, round: battle.currentRound + 1, entries: ids.length, refund };
    });
    if (!next) return;
    if (next.refund.length > 0) await this.finalSpots?.refundUnused(next.refund);
    if (next.final !== undefined) {
      if (next.final === null) await this.cancelEmpty(battleId);
      else await this.finishBattle(battleId, next.final);
      return;
    }
    await this.prepareAnnouncement(await this.roundAnnouncement(next.battle, next.round!, next.entries!));
    await this.prepareByePost(next.battle, next.round!);
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
    const targets = await this.postTargets();
    if (!targets.auto) await this.notifications.notifyAdmins((l) => l.admin.announcementReady);
    for (const chatId of targets.chats) {
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
      const keyboard = activeDuelKeyboard(
        this.locale,
        { id: duel.id, stage: duel.stage, votes: voteList(duel), stacked: duel.stackedButtons, ...(duel.endsAt ? { endsAt: this.time(duel.endsAt) } : {}) },
        settings.paidVotesEnabled,
      );
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, keyboard);
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
      await this.telegram.editMessageReplyMarkup(this.channel.id, duel.messageId, closedDuelKeyboard(this.locale, { id: duel.id, stage: duel.stage, votes: voteList(duel), stacked: duel.stackedButtons }, winner));
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
    const duels = await this.prisma.duel.findMany({ where: { battleId, round }, select: { photoAId: true, photoBId: true, photoCId: true, photoDId: true, photoEId: true, photoFId: true } });
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

  /**
   * An entry that advances without a vote (odd number of entries) gets its own
   * post, prepared for the admins to forward; its author is told too.
   */
  private async prepareByePost(battle: Battle, round: number): Promise<void> {
    const bye = await this.prisma.duel.findFirst({ where: { battleId: battle.id, round, photoBId: null }, include: { photoA: { include: { user: true } } } });
    if (!bye) return;
    const entries = await this.roundEntries(battle.id, round);
    const caption = await this.render('bye', { battle: battle.title, round, roundName: roundName(this.locale, round, entries, battle.finalSize) });
    const photo = bye.photoA;
    const targets = await this.postTargets();
    if (!targets.auto) await this.notifications.notifyAdmins((l) => l.admin.byeReady(round));
    for (const chatId of targets.chats) {
      const send = (text: string) =>
        photo.mediaType === 'VIDEO'
          ? this.telegram.sendMediaGroup(chatId, [{ type: 'video', fileId: photo.fileId, caption: text }])
          : this.telegram.sendPhoto(chatId, photo.fileId, { caption: text, parseMode: 'HTML' });
      try {
        await send(caption).catch(async (error: unknown) => {
          // Premium emoji need the bot owner's Telegram Premium; without it send regular emoji.
          if (classifyTelegramError(error).kind !== 'permanent' || !caption.includes('<tg-emoji')) throw error;
          await this.emojiRejected('bye', classifyTelegramError(error).description);
          await send(stripCustomEmoji(caption));
        });
      } catch (error) {
        this.logger.error({ err: error, battleId: battle.id, round }, 'Failed to prepare the bye post');
      }
    }
    await this.notifications.notifyUser(photo.user, (l) => l.battle.byeDm(round));
  }

  /**
   * A place given while the final is already running: the entry joins the final
   * post in the next free slot (up to 6). A post already sent to admins or
   * published is prepared again; votes given so far are kept.
   */
  async joinRunningFinal(spotId: number): Promise<boolean> {
    const spot = await this.prisma.finalSpot.findUnique({ where: { id: spotId }, include: { battle: true, photo: true } });
    if (!spot?.photo || spot.usedAt || spot.refundedAt || spot.battle.status !== 'RUNNING' || spot.photo.status !== 'ACCEPTED') return false;
    const battle = spot.battle;
    const duels = await this.prisma.duel.findMany({ where: { battleId: battle.id, round: battle.currentRound } });
    const final = duels.length === 1 ? duels[0]! : null;
    if (!final || !isFinalRound(battle, entryCount(final)) || final.status === 'FINISHED') return false;
    const free = SIDES.find((side) => final[PHOTO_ID_FIELD[side]] === null);
    if (!free) return false;

    const joined = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.finalSpot.updateMany({ where: { id: spot.id, usedAt: null, refundedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count === 0) return false;
      const updated = await tx.duel.updateMany({ where: { id: final.id, [PHOTO_ID_FIELD[free]]: null, status: final.status }, data: { [PHOTO_ID_FIELD[free]]: spot.photoId } });
      if (updated.count === 0) throw new DomainError('INVALID_STATE');
      await tx.photo.update({ where: { id: spot.photoId! }, data: { status: 'IN_BATTLE' } });
      const size = entryCount(final) + 1;
      if (size > battle.finalSize) await tx.battle.update({ where: { id: battle.id }, data: { finalSize: size } });
      return true;
    });
    if (!joined) return false;
    const size = entryCount(final) + 1;
    const auto = (await this.settings.get()).autoPublish;
    await this.notifications.notifyAdmins((l) => l.admin.finalJoined(size, auto));
    // Admins get the new final post (now with the extra entry) to publish again.
    if (final.status === 'READY' || final.status === 'ACTIVE') await this.republish(final.id, null);
    return true;
  }

  private readonly heldPayments = new Set<number>();

  /**
   * A card transfer for an entry of this pair is being paid or waits for an
   * admin: the pair stays open (5 more minutes at a time, at most 30 minutes
   * after "I paid"), so the votes count where they were meant to.
   */
  private async holdForTransfer(duelId: number, now: Date): Promise<boolean> {
    const duel = await this.prisma.duel.findUnique({ where: { id: duelId } });
    if (duel?.status !== 'ACTIVE') return false;
    const pending = await this.prisma.payment.findFirst({
      where: {
        method: 'TRANSFER',
        targetPhotoId: { in: entriesOf(duel).map((entry) => entry.photoId) },
        OR: [
          { status: 'CLAIMED', claimedAt: { gte: new Date(now.getTime() - TRANSFER_HOLD_MAX_MS) } },
          { status: 'PENDING', expiresAt: { gt: now } },
        ],
      },
      orderBy: { id: 'asc' },
    });
    if (!pending) return false;
    const endsAt = new Date(now.getTime() + TRANSFER_HOLD_STEP_MS);
    const held = await this.prisma.duel.updateMany({ where: { id: duel.id, status: 'ACTIVE', stage: duel.stage }, data: { endsAt } });
    if (held.count === 0) return false;
    await this.scheduler.scheduleTickAt(endsAt, `hold-${duel.id}-${endsAt.getTime()}`);
    await this.scheduler.scheduleVoteRefresh(duel.id); // the new end time shows under the buttons
    if (pending.status === 'CLAIMED' && !this.heldPayments.has(pending.id)) {
      this.heldPayments.add(pending.id);
      const entriesInRound = await this.roundEntries(duel.battleId, duel.round);
      const finalSize = (await this.prisma.battle.findUnique({ where: { id: duel.battleId }, select: { finalSize: true } }))?.finalSize ?? 2;
      const stageInfo = { round: duel.round, entriesInRound, duel: duel.position, stage: duel.stage, finalSize };
      await this.notifications.notifyAdmins((l) => l.admin.duelHeldForTransfer({ stage: stageValues(l, stageInfo).stage as string, code: pending.code ?? '' }));
    }
    return true;
  }

  /** Bought places whose photo is ready join the final; places without a photo are refunded. */
  private async takeSpotsIntoFinal(tx: Prisma.TransactionClient, battleId: number): Promise<{ photoIds: number[]; refund: number[] }> {
    const spots = await tx.finalSpot.findMany({ where: { battleId, refundedAt: null, usedAt: null }, include: { photo: true }, orderBy: { id: 'asc' } });
    const ready = spots.filter((spot) => spot.photo?.status === 'ACCEPTED');
    if (ready.length > 0) {
      await tx.finalSpot.updateMany({ where: { id: { in: ready.map((spot) => spot.id) } }, data: { usedAt: new Date() } });
      await tx.photo.updateMany({ where: { id: { in: ready.map((spot) => spot.photoId!) } }, data: { status: 'IN_BATTLE' } });
    }
    return { photoIds: ready.map((spot) => spot.photoId!), refund: spots.filter((spot) => !ready.includes(spot)).map((spot) => spot.id) };
  }

  /** Channel announcements are prepared for the admins too: a short note, then the ready text to forward. */
  private async prepareAnnouncement(html: string): Promise<void> {
    if ((await this.settings.get()).autoPublish) {
      await this.publishText(html);
      return;
    }
    await this.notifications.notifyAdmins((l) => l.admin.announcementReady);
    await this.notifications.notifyAdmins(() => html, { parseMode: 'HTML', disablePreview: true });
  }

  /** Auto mode: a text post goes straight to the channel (regular emoji if premium ones are refused). */
  private async publishText(html: string): Promise<void> {
    const options = { parseMode: 'HTML' as const, disablePreview: true };
    try {
      await this.telegram.sendMessage(this.channel.id, html, options);
    } catch (error) {
      const classified = classifyTelegramError(error);
      if (classified.kind !== 'permanent' || !html.includes('<tg-emoji')) {
        this.logger.error({ err: error }, 'Failed to publish an announcement');
        return;
      }
      await this.emojiRejected('duel', classified.description);
      await this.telegram.sendMessage(this.channel.id, stripCustomEmoji(html), options).catch((err: unknown) => this.logger.error({ err }, 'Failed to publish an announcement'));
    }
  }

  /** Where ready posts go: the channel itself in auto mode, otherwise the admins' chats. */
  private async postTargets(): Promise<{ auto: boolean; chats: number[] }> {
    const auto = (await this.settings.get()).autoPublish;
    return { auto, chats: auto ? [this.channel.id] : await this.notifications.adminChatIds() };
  }

  private lastEmojiAlert = 0;

  /**
   * Telegram refused premium emoji, so the post goes out with their regular
   * fallback (often ❤️). Admins get Telegram's exact reason (at most hourly).
   */
  private async emojiRejected(where: 'duel' | 'buttons' | 'bye', reason: string): Promise<void> {
    this.logger.warn({ where, error: reason }, 'Custom emoji rejected, sent with regular emoji');
    if (Date.now() - this.lastEmojiAlert < 60 * 60_000) return;
    this.lastEmojiAlert = Date.now();
    await this.notifications.notifyAdmins((l) => l.admin.emojiRejected({ where: l.admin.emojiPlaces[where], reason: escapeHtml(truncate(reason, 200)) }));
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
