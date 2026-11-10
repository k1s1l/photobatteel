import type { Battle, FinalSpot, Prisma, PrismaClient, User } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { TelegramGateway } from '../contracts.js';
import { entryCount, MAX_FINAL_SIZE } from '../duels/sides.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { DraftInput } from '../photos/photo.service.js';

type Db = PrismaClient | Prisma.TransactionClient;

export const FINAL_SPOT_PAYLOAD_PREFIX = 'spot:';
const STARS_CURRENCY = 'XTR';
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
/** Battles with more entries than this open the sale one round later. */
export const BIG_BATTLE_ENTRIES = 24;

export interface FinalSpotOptions {
  /** Price of a place in Stars. */
  price: number;
  /** Places on sale per battle (0 = off). */
  maxSpots: number;
}

export type SpotUnavailableReason = 'DISABLED' | 'NO_BATTLE' | 'TOO_EARLY' | 'FINAL_STARTED' | 'SOLD_OUT' | 'ALREADY_BOUGHT' | 'STILL_PLAYING';

export type SpotOffer =
  | { available: true; battle: Battle; price: number; left: number }
  | { available: false; reason: SpotUnavailableReason; fromRound?: number };

/** What happened after a successful Stars payment for a place. */
export type SpotPurchase = { kind: 'reserved'; spot: FinalSpot; battle: Battle } | { kind: 'refunded'; reason: SpotUnavailableReason } | { kind: 'duplicate' };

export function finalSpotPayload(paymentId: number): string {
  return `${FINAL_SPOT_PAYLOAD_PREFIX}${paymentId}`;
}

export function parseFinalSpotPayload(payload: string): number | null {
  if (!payload.startsWith(FINAL_SPOT_PAYLOAD_PREFIX)) return null;
  const id = Number(payload.slice(FINAL_SPOT_PAYLOAD_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The final: the round where all remaining entries fit in one post. */
export function isFinalRound(battle: Pick<Battle, 'finalSize'>, entriesInRound: number): boolean {
  return entriesInRound <= Math.max(2, battle.finalSize);
}

async function roundEntries(db: Db, battleId: number, round: number): Promise<number> {
  const duels = await db.duel.findMany({ where: { battleId, round }, select: { photoAId: true, photoBId: true, photoCId: true, photoDId: true } });
  return duels.reduce((sum, duel) => sum + entryCount(duel), 0);
}

/**
 * Places in the final for sale: up to `maxSpots` per battle, never more than the
 * final post can hold (4 entries) next to the regular finalists. The sale opens
 * in round 2 (round 3 for battles of more than 24 entries) and closes when the
 * final starts. Anyone may buy — also people without an entry — except those
 * whose entry is still playing.
 */
export async function spotOffer(db: Db, userId: number | null, options: FinalSpotOptions): Promise<SpotOffer> {
  if (options.maxSpots <= 0) return { available: false, reason: 'DISABLED' };
  const battle = await db.battle.findFirst({ where: { status: 'RUNNING' }, orderBy: { id: 'desc' } });
  if (!battle || battle.currentRound === 0) return { available: false, reason: 'NO_BATTLE' };
  const startEntries = await roundEntries(db, battle.id, 1);
  const fromRound = startEntries > BIG_BATTLE_ENTRIES ? 3 : 2;
  const finalStarted =
    isFinalRound(battle, await roundEntries(db, battle.id, battle.currentRound)) ||
    (await db.finalSpot.count({ where: { battleId: battle.id, usedAt: { not: null } } })) > 0;
  if (finalStarted) return { available: false, reason: 'FINAL_STARTED' };
  if (battle.currentRound < fromRound) return { available: false, reason: 'TOO_EARLY', fromRound };
  const capacity = Math.min(options.maxSpots, MAX_FINAL_SIZE - Math.max(2, battle.finalSize));
  const taken = await db.finalSpot.count({ where: { battleId: battle.id, refundedAt: null } });
  if (taken >= capacity) return { available: false, reason: 'SOLD_OUT' };
  if (userId !== null) {
    if (await db.finalSpot.findUnique({ where: { battleId_userId: { battleId: battle.id, userId } } })) return { available: false, reason: 'ALREADY_BOUGHT' };
    if (await db.photo.count({ where: { battleId: battle.id, userId, status: 'IN_BATTLE' } })) return { available: false, reason: 'STILL_PLAYING' };
  }
  return { available: true, battle, price: options.price, left: capacity - taken };
}

/** Places taken in a battle (not refunded): limits how big the regular final may be. */
export async function takenSpots(db: Db, battleId: number): Promise<number> {
  return db.finalSpot.count({ where: { battleId, refundedAt: null } });
}

/**
 * Buying a place in the final for Stars, collecting the buyer's photo for it,
 * and refunding places that cannot be used.
 */
export class FinalSpotService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
    readonly options: FinalSpotOptions,
  ) {}

  async offer(user: User | null): Promise<SpotOffer> {
    return spotOffer(this.prisma, user?.id ?? null, this.options);
  }

  /** Creates a pending Stars order for a place; the caller sends the invoice. */
  async createInvoice(user: User): Promise<{ payload: string; amount: number; currency: string; battle: Battle }> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    const offer = await this.offer(user);
    if (!offer.available) throw new DomainError('FINAL_SPOT_UNAVAILABLE', { reason: offer.reason, fromRound: offer.fromRound ?? 0 });
    const payment = await this.prisma.payment.create({
      data: { userId: user.id, votes: 0, method: 'STARS', currency: STARS_CURRENCY, amount: offer.price, finalSpotBattleId: offer.battle.id },
    });
    return { payload: finalSpotPayload(payment.id), amount: offer.price, currency: STARS_CURRENCY, battle: offer.battle };
  }

  /** pre_checkout_query: false when the place can no longer be sold. */
  async validateCheckout(input: { payload: string; telegramUserId: number; currency: string; totalAmount: number }): Promise<'expired' | 'unavailable' | null> {
    const id = parseFinalSpotPayload(input.payload);
    const payment = id ? await this.prisma.payment.findUnique({ where: { id }, include: { user: true } }) : null;
    if (!payment || payment.status !== 'PENDING' || payment.finalSpotBattleId === null) return 'expired';
    if (payment.user.telegramId !== BigInt(input.telegramUserId)) return 'expired';
    if (payment.currency !== input.currency || payment.amount !== input.totalAmount) return 'expired';
    if (Date.now() - payment.createdAt.getTime() > ORDER_TTL_MS) return 'expired';
    const offer = await this.offer(payment.user);
    if (!offer.available || offer.battle.id !== payment.finalSpotBattleId) return 'unavailable';
    return null;
  }

  /**
   * successful_payment: reserves the place, or — when the last place was sold a
   * moment earlier — returns the Stars right away. Idempotent by charge id.
   */
  async completePayment(input: { payload: string; telegramUserId: number; telegramChargeId: string }): Promise<SpotPurchase> {
    const id = parseFinalSpotPayload(input.payload);
    if (!id) throw new Error(`Unknown final spot payload: ${input.payload}`);
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id }, include: { user: true } });
      if (payment.user.telegramId !== BigInt(input.telegramUserId)) throw new Error(`Payment ${id} belongs to another user`);
      const claimed = await tx.payment.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date(), telegramChargeId: input.telegramChargeId },
      });
      if (claimed.count === 0) return { kind: 'duplicate' as const };
      // Serialize sales of the same battle so two buyers cannot take one last place.
      await tx.$executeRaw`SELECT id FROM "Battle" WHERE id = ${payment.finalSpotBattleId} FOR UPDATE`;
      const offer = await spotOffer(tx, payment.userId, this.options);
      if (!offer.available || offer.battle.id !== payment.finalSpotBattleId) return { kind: 'refund' as const, reason: offer.available ? ('FINAL_STARTED' as const) : offer.reason, payment };
      const spot = await tx.finalSpot.create({ data: { battleId: offer.battle.id, userId: payment.userId, paymentId: payment.id } });
      await this.activity.log(
        { action: 'PAYMENT_SUCCEEDED', userId: payment.userId, entityType: 'Payment', entityId: payment.id, details: { method: 'STARS', amount: payment.amount, finalSpot: spot.id } },
        tx,
      );
      return { kind: 'reserved' as const, spot, battle: offer.battle, user: payment.user };
    });
    if (result.kind === 'duplicate') return result;
    if (result.kind === 'refund') {
      await this.refundPayment(result.payment.id, Number(result.payment.user.telegramId), input.telegramChargeId);
      return { kind: 'refunded', reason: result.reason };
    }
    // Only admins see who bought a place; it is never shown in the channel.
    const who = escapeHtml([result.user.firstName, result.user.username ? `@${result.user.username}` : ''].filter(Boolean).join(' '));
    await this.notifications.notifyAdmins((l) => l.admin.finalSpotSold({ who, price: this.options.price }));
    return { kind: 'reserved', spot: result.spot, battle: result.battle };
  }

  /** The buyer's place that still waits for a photo (or may change it) before the final starts. */
  async openSpot(userId: number): Promise<(FinalSpot & { battle: Battle }) | null> {
    return this.prisma.finalSpot.findFirst({
      where: { userId, refundedAt: null, usedAt: null, battle: { status: 'RUNNING' } },
      include: { battle: true },
      orderBy: { id: 'desc' },
    });
  }

  /**
   * Stores the buyer's photo or video for the final. Their own earlier entry may
   * be sent again; somebody else's file may not.
   */
  async attachPhoto(user: User, input: DraftInput): Promise<FinalSpot> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    if (!user.consentAt) throw new DomainError('CONSENT_REQUIRED');
    const spot = await this.openSpot(user.id);
    if (!spot) throw new DomainError('INVALID_STATE');
    const foreign = await this.prisma.photo.findFirst({
      where: { userId: { not: user.id }, status: { notIn: ['DRAFT', 'CANCELLED', 'DELETED'] }, OR: [{ contentHash: input.contentHash }, { fileUniqueId: input.fileUniqueId }] },
      select: { id: true },
    });
    if (foreign) throw new DomainError('DUPLICATE_PHOTO');
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.finalSpot.findUniqueOrThrow({ where: { id: spot.id } });
      if (current.usedAt || current.refundedAt) throw new DomainError('INVALID_STATE');
      // A new photo replaces the one sent earlier for this place.
      if (current.photoId) await tx.photo.update({ where: { id: current.photoId }, data: { status: 'CANCELLED' } });
      const photo = await tx.photo.create({
        data: { ...input, durationSec: input.durationSec ?? null, userId: user.id, battleId: spot.battleId, status: 'ACCEPTED', confirmedAt: new Date() },
      });
      await this.activity.log({ action: 'PHOTO_CONFIRMED', userId: user.id, entityType: 'Photo', entityId: photo.id, details: { finalSpot: spot.id } }, tx);
      return tx.finalSpot.update({ where: { id: spot.id }, data: { photoId: photo.id } });
    });
  }

  /** Returns the Stars of places that will not be used (no photo before the final, or the battle ended). */
  async refundUnused(spotIds: number[]): Promise<void> {
    for (const spotId of spotIds) {
      const spot = await this.prisma.finalSpot.findUnique({ where: { id: spotId }, include: { payment: true, user: true } });
      if (!spot || spot.refundedAt || spot.usedAt || !spot.payment.telegramChargeId) continue;
      const marked = await this.prisma.finalSpot.updateMany({ where: { id: spotId, refundedAt: null, usedAt: null }, data: { refundedAt: new Date() } });
      if (marked.count === 0) continue;
      if (spot.photoId) await this.prisma.photo.updateMany({ where: { id: spot.photoId, status: 'ACCEPTED' }, data: { status: 'CANCELLED' } });
      await this.refundPayment(spot.paymentId, Number(spot.user.telegramId), spot.payment.telegramChargeId);
      await this.notifications.notifyUser(spot.user, (l) => l.finalSpot.refunded(this.options.price));
    }
  }

  private async refundPayment(paymentId: number, telegramUserId: number, chargeId: string): Promise<void> {
    try {
      await this.telegram.refundStarPayment(telegramUserId, chargeId);
      await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'REFUNDED', refundedAt: new Date() } });
      await this.activity.log({ action: 'PAYMENT_REFUNDED', userId: null, entityType: 'Payment', entityId: paymentId, details: { finalSpot: true } });
    } catch (error) {
      this.logger.error({ err: error, paymentId }, 'Final spot refund failed');
      await this.notifications.notifyAdmins((l) => l.admin.finalSpotRefundFailed(paymentId));
    }
  }
}
