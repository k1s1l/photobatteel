import type { InlineKeyboardMarkup } from 'telegraf/types';
import { randomInt } from 'node:crypto';
import { inAnySlot, sideNumber, sideOf, VOTE_FIELD, VOTE_SELECT, votesOf } from '../duels/sides.js';
import type { Duel, DuelSide, Payment, PaymentMethod, Photo, Prisma, PrismaClient, User, VotePackage } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import { escapeHtml, formatCardPrice } from '../../lib/format.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { JobScheduler, TelegramGateway } from '../contracts.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { spotOffer, spotRules } from '../final-spots/final-spot.service.js';
import { BankRateLimitError, type BankStatementItem, type BankWebhookEvent, currencyNumericCode, type BankClient } from './monobank.js';

export const STARS_CURRENCY = 'XTR';
const PAYLOAD_PREFIX = 'order:';
/** Invoices older than this are refused at checkout. */
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default packs created on first start; admins can change prices or hide packs. */
export const DEFAULT_PACKAGES = [
  { votes: 10, priceStars: 10, priceCard: 1000, sortOrder: 1, bonusCard: 1, starsEnabled: false },
  { votes: 20, priceStars: 20, priceCard: 2000, sortOrder: 2, bonusCard: 3, starsEnabled: true },
  { votes: 50, priceStars: 50, priceCard: 5000, sortOrder: 3, bonusCard: 10, starsEnabled: true },
  { votes: 100, priceStars: 100, priceCard: 10000, sortOrder: 4, bonusCard: 25, starsEnabled: true },
] as const;

/** Monobank jars accept transfers from 10 UAH, so a card price below that cannot be paid. */
export const MIN_CARD_PRICE = 1000;

export interface PaymentOptions {
  /** A Telegram payment provider token is configured (in-Telegram card payments). */
  cardEnabled: boolean;
  cardCurrency: string;
  /** How long a buyer has to make a transfer before the order expires. */
  transferTtlMinutes: number;
  /** Without bank verification: how long a claimed transfer waits for an admin. */
  manualReviewHours: number;
  /** Minutes the bank check may take before admins are asked (default 5). */
  reviewAfterMinutes?: number;
  /** Paid votes near the end of a pair extend its voting by this many minutes (0 = off, default 0). */
  overtimeMinutes?: number;
}

export type TransferOutcome = { kind: 'paid'; completed: CompletedPayment; telegramId: bigint; languageCode: string } | { kind: 'cancelled' };

/** Letters and digits that cannot be confused with each other in a payment comment. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Invoice {
  payment: Payment;
  payload: string;
  currency: string;
  amount: number;
  votes: number;
}

export type CheckoutProblem = 'expired' | 'unavailable' | 'disabled';

type Db = PrismaClient | Prisma.TransactionClient;

/** The open duel an entry is playing right now, and its side in it. */
export async function findActiveDuel(db: Db, photoId: number, now: Date = new Date()): Promise<{ duel: Duel; side: DuelSide } | null> {
  const duel = await db.duel.findFirst({
    where: { status: 'ACTIVE', endsAt: { gt: now }, ...inAnySlot(photoId) },
  });
  const side = duel ? sideOf(duel, photoId) : null;
  return duel && side ? { duel, side } : null;
}

/** A transfer that ran out of time is still accepted when the money arrives within a day. */
const LATE_TRANSFER_MS = 24 * 60 * 60_000;

/** Expired (not rejected by an admin) transfer orders that may still be paid. */
function lateTransfers(now: Date = new Date()): Prisma.PaymentWhereInput {
  return { method: 'TRANSFER', status: 'CANCELLED', confirmedById: null, createdAt: { gte: new Date(now.getTime() - LATE_TRANSFER_MS) } };
}

export type BankDiagnosis =
  | { kind: 'no_token' }
  | { kind: 'no_account' }
  | { kind: 'wait'; seconds: number }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; total: number; incoming: { time: Date; amount: number; text: string }[]; credited: number; open: number };

export interface CompletedPayment {
  payment: Payment;
  /** 'photo' — votes went to the target entry's current duel; 'balance' — to the buyer's balance. */
  creditedTo: 'photo' | 'balance';
  /** Set when the target photo was no longer votable and votes went to the balance instead. */
  targetUnavailable: boolean;
  balance: number;
  alreadyProcessed: boolean;
  /** A transfer for a place in the final: the place is taken, or it was sold out meanwhile (money goes back by hand). */
  finalSpot?: 'reserved' | 'unavailable';
}

export interface PaymentStats {
  paid: number;
  paid24h: number;
  stars: number;
  cardTotal: number;
  card24h: number;
  votesSold: number;
}

export function orderPayload(paymentId: number): string {
  return `${PAYLOAD_PREFIX}${paymentId}`;
}

export function parseOrderPayload(payload: string): number | null {
  if (!payload.startsWith(PAYLOAD_PREFIX)) return null;
  const id = Number(payload.slice(PAYLOAD_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Paid votes. Purchases are Telegram invoices (Stars or card via a provider).
 * Votes are credited only on `successful_payment`, exactly once per Telegram charge id.
 */
export class PaymentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly activity: ActivityService,
    private readonly scheduler: JobScheduler,
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
    readonly options: PaymentOptions,
    private readonly notifications: NotificationService,
    /** Monobank client when MONOBANK_TOKEN is set; null means transfers are confirmed by admins. */
    readonly bank: BankClient | null = null,
  ) {}

  /** Overtime: a pair with less than N minutes left gets N minutes from now. */
  private async extendNearEnd(db: Db, duel: Duel): Promise<void> {
    const overtimeMs = (this.options.overtimeMinutes ?? 0) * 60_000;
    const now = Date.now();
    if (overtimeMs <= 0 || !duel.endsAt || duel.endsAt.getTime() - now >= overtimeMs) return;
    const endsAt = new Date(now + overtimeMs);
    const extended = await db.duel.updateMany({ where: { id: duel.id, status: 'ACTIVE', stage: duel.stage, endsAt: { lt: endsAt } }, data: { endsAt } });
    if (extended.count > 0) this.pendingOvertime.push({ duelId: duel.id, stage: duel.stage, endsAt });
  }

  /** Somebody started paying for an entry: its pair must not close before the payment can count. */
  private async holdForPayment(targetPhotoId: number | null): Promise<void> {
    if (targetPhotoId === null) return;
    const active = await findActiveDuel(this.prisma, targetPhotoId);
    if (!active) return;
    await this.extendNearEnd(this.prisma, active.duel);
    await this.scheduleOvertime();
  }

  /** Duel ends moved by overtime inside a transaction; their ticks are scheduled after it commits. */
  private pendingOvertime: { duelId: number; stage: number; endsAt: Date }[] = [];

  private async scheduleOvertime(): Promise<void> {
    const due = this.pendingOvertime.splice(0);
    for (const item of due) {
      await this.scheduler.scheduleTickAt(item.endsAt, `duel-${item.duelId}-${item.stage}-ot-${item.endsAt.getTime()}`);
      // The new end time shows under the vote buttons.
      await this.scheduler.scheduleVoteRefresh(item.duelId);
    }
  }

  private lastBankPoll = 0;

  async ensureDefaultPackages(): Promise<void> {
    if ((await this.prisma.votePackage.count()) > 0) return;
    await this.prisma.votePackage.createMany({ data: DEFAULT_PACKAGES.map((pack) => ({ ...pack })) });
  }

  async listPackages(activeOnly: boolean): Promise<VotePackage[]> {
    return this.prisma.votePackage.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { votes: 'asc' }],
    });
  }

  async getPackage(id: number): Promise<VotePackage | null> {
    return this.prisma.votePackage.findUnique({ where: { id } });
  }

  async updatePackagePrice(id: number, priceStars: number, priceCard: number, adminUserId: number): Promise<VotePackage> {
    if (!Number.isInteger(priceStars) || priceStars < 1 || priceStars > 100_000) throw new RangeError('Invalid Stars price');
    if (!Number.isInteger(priceCard) || priceCard < MIN_CARD_PRICE || priceCard > 100_000_000) throw new RangeError('Invalid card price');
    const pack = await this.prisma.votePackage.update({ where: { id }, data: { priceStars, priceCard } });
    await this.activity.log({ action: 'PACKAGE_UPDATED', userId: adminUserId, entityType: 'VotePackage', entityId: id, details: { priceStars, priceCard } });
    return pack;
  }

  /** Bonus votes for paying the pack by card / jar. */
  async setPackageBonus(id: number, bonus: number, adminUserId: number): Promise<VotePackage> {
    if (!Number.isInteger(bonus) || bonus < 0 || bonus > 100_000) throw new RangeError('Invalid bonus');
    const pack = await this.prisma.votePackage.update({ where: { id }, data: { bonusCard: bonus } });
    await this.activity.log({ action: 'PACKAGE_UPDATED', userId: adminUserId, entityType: 'VotePackage', entityId: id, details: { bonusCard: bonus } });
    return pack;
  }

  /** Sell the pack for Stars too, or only for money. */
  async toggleStars(id: number, adminUserId: number): Promise<VotePackage> {
    const current = await this.prisma.votePackage.findUniqueOrThrow({ where: { id } });
    const pack = await this.prisma.votePackage.update({ where: { id }, data: { starsEnabled: !current.starsEnabled } });
    await this.activity.log({ action: 'PACKAGE_UPDATED', userId: adminUserId, entityType: 'VotePackage', entityId: id, details: { starsEnabled: pack.starsEnabled } });
    return pack;
  }

  async togglePackage(id: number, adminUserId: number): Promise<VotePackage> {
    const current = await this.prisma.votePackage.findUniqueOrThrow({ where: { id } });
    const pack = await this.prisma.votePackage.update({ where: { id }, data: { isActive: !current.isActive } });
    await this.activity.log({ action: 'PACKAGE_UPDATED', userId: adminUserId, entityType: 'VotePackage', entityId: id, details: { isActive: pack.isActive } });
    return pack;
  }

  /** Creates a pending order; the caller sends the invoice built from the result. */
  async createInvoice(user: User, packageId: number, method: PaymentMethod, targetPhotoId: number | null): Promise<Invoice> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    const settings = await this.settings.get();
    if (!settings.paidVotesEnabled) throw new DomainError('PAYMENTS_DISABLED');
    if (method === 'CARD' && !this.options.cardEnabled) throw new DomainError('PAYMENTS_DISABLED');
    const pack = await this.prisma.votePackage.findUnique({ where: { id: packageId } });
    if (!pack?.isActive || (method === 'STARS' && !pack.starsEnabled)) throw new DomainError('NOT_FOUND');
    if (targetPhotoId !== null && !(await findActiveDuel(this.prisma, targetPhotoId))) throw new DomainError('VOTING_CLOSED');
    const currency = method === 'STARS' ? STARS_CURRENCY : this.options.cardCurrency;
    const amount = method === 'STARS' ? pack.priceStars : pack.priceCard;
    // Paying with money gives the pack's bonus votes.
    const votes = method === 'STARS' ? pack.votes : pack.votes + pack.bonusCard;
    const payment = await this.prisma.payment.create({
      data: { userId: user.id, packageId: pack.id, votes, method, currency, amount, targetPhotoId },
    });
    await this.holdForPayment(targetPhotoId);
    return { payment, payload: orderPayload(payment.id), currency, amount, votes };
  }

  /** pre_checkout_query validation: returns a problem or null when the payment may proceed. */
  async validateCheckout(input: { payload: string; telegramUserId: number; currency: string; totalAmount: number }): Promise<CheckoutProblem | null> {
    const id = parseOrderPayload(input.payload);
    if (!id) return 'expired';
    const payment = await this.prisma.payment.findUnique({ where: { id }, include: { user: true } });
    if (!payment || payment.status !== 'PENDING') return 'expired';
    if (payment.user.telegramId !== BigInt(input.telegramUserId)) return 'expired';
    if (payment.currency !== input.currency || payment.amount !== input.totalAmount) return 'expired';
    if (Date.now() - payment.createdAt.getTime() > ORDER_TTL_MS) return 'expired';
    if (payment.user.isBlocked) return 'disabled';
    const settings = await this.settings.get();
    if (!settings.paidVotesEnabled) return 'disabled';
    if (payment.targetPhotoId !== null && !(await findActiveDuel(this.prisma, payment.targetPhotoId))) return 'unavailable';
    return null;
  }

  /**
   * successful_payment: the money is already taken, so votes are always credited —
   * to the target photo when it is still published, otherwise to the balance.
   * Idempotent by Telegram charge id.
   */
  async completePayment(input: {
    payload: string;
    telegramUserId: number;
    currency: string;
    totalAmount: number;
    telegramChargeId: string;
    providerChargeId: string;
  }): Promise<CompletedPayment> {
    const id = parseOrderPayload(input.payload);
    if (!id) throw new Error(`Unknown invoice payload: ${input.payload}`);

    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id }, include: { user: true } });
    if (payment.user.telegramId !== BigInt(input.telegramUserId)) throw new Error(`Payment ${id} belongs to another user`);
    if (payment.currency !== input.currency || payment.amount !== input.totalAmount) {
      this.logger.error({ paymentId: id, expected: [payment.currency, payment.amount], got: [input.currency, input.totalAmount] }, 'Paid amount differs from the order');
    }
    return this.credit(id, { telegramChargeId: input.telegramChargeId, providerChargeId: input.providerChargeId || null });
  }

  /**
   * Marks a payment as paid and credits its votes exactly once: to the target
   * entry's open duel when there is one, otherwise to the buyer's balance.
   */
  private async credit(paymentId: number, paidData: Prisma.PaymentUpdateManyMutationInput): Promise<CompletedPayment> {
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { user: true } });
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, OR: [{ status: { in: ['PENDING', 'CLAIMED'] } }, lateTransfers()] },
        data: { ...paidData, status: 'PAID', paidAt: new Date() },
      });
      if (claimed.count === 0) {
        return { payment, creditedTo: 'balance' as const, targetUnavailable: false, balance: payment.user.voteBalance, alreadyProcessed: true, duelId: null };
      }

      // A transfer for a place in the final: take the place instead of crediting votes.
      if (payment.finalSpotBattleId !== null) {
        await tx.$executeRaw`SELECT id FROM "Battle" WHERE id = ${payment.finalSpotBattleId} FOR UPDATE`;
        const offer = await spotOffer(tx, payment.userId, spotRules(await this.settings.get()));
        const reserved = offer.available && offer.battle.id === payment.finalSpotBattleId;
        if (reserved) await tx.finalSpot.create({ data: { battleId: payment.finalSpotBattleId, userId: payment.userId, paymentId: payment.id } });
        else await tx.payment.update({ where: { id: paymentId }, data: { status: 'REFUNDED', refundedAt: new Date() } });
        await this.activity.log(
          {
            action: 'PAYMENT_SUCCEEDED',
            userId: payment.userId,
            entityType: 'Payment',
            entityId: paymentId,
            details: { method: payment.method, amount: payment.amount, currency: payment.currency, finalSpot: reserved ? 'reserved' : 'unavailable' },
          },
          tx,
        );
        const paid = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        return {
          payment: paid,
          creditedTo: 'balance' as const,
          targetUnavailable: false,
          balance: payment.user.voteBalance,
          alreadyProcessed: false,
          duelId: null,
          finalSpot: reserved ? ('reserved' as const) : ('unavailable' as const),
        };
      }

      let creditedTo: 'photo' | 'balance' = 'balance';
      let targetUnavailable = false;
      let duelId: number | null = null;
      if (payment.targetPhotoId !== null) {
        const photo = await tx.photo.findUnique({ where: { id: payment.targetPhotoId } });
        const active = photo ? await findActiveDuel(tx, photo.id) : null;
        if (photo && active) {
          await this.applyVotes(tx, photo, active.duel, active.side, payment.userId, payment.votes, payment.id);
          creditedTo = 'photo';
          duelId = active.duel.id;
        } else {
          targetUnavailable = true;
        }
      }
      let balance = payment.user.voteBalance;
      if (creditedTo === 'balance') {
        balance = (await tx.user.update({ where: { id: payment.userId }, data: { voteBalance: { increment: payment.votes } } })).voteBalance;
      }
      await this.activity.log(
        {
          action: 'PAYMENT_SUCCEEDED',
          userId: payment.userId,
          entityType: 'Payment',
          entityId: paymentId,
          details: { method: payment.method, amount: payment.amount, currency: payment.currency, votes: payment.votes, creditedTo },
        },
        tx,
      );
      const paid = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      return { payment: paid, creditedTo, targetUnavailable, balance, alreadyProcessed: false, duelId };
    });

    if (result.finalSpot) {
      if (!result.alreadyProcessed) await this.announceSpot(result.payment, result.finalSpot);
      const { duelId: _spotDuel, ...spotCompleted } = result;
      return spotCompleted;
    }
    await this.scheduleOvertime();
    if (result.duelId) await this.scheduler.scheduleVoteRefresh(result.duelId);
    // Admins see every payment that went through by itself (one they confirmed themselves they already know about).
    if (!result.alreadyProcessed && paidData.confirmedById === undefined) await this.announcePayment(result.payment, result.creditedTo === 'photo');
    const { duelId: _duelId, ...completed } = result;
    return completed;
  }

  /** Spends purchased votes from the balance on an entry that is playing a duel right now. */
  async spendVotes(user: User, photoId: number, amount: number): Promise<{ balance: number; votes: number }> {
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) throw new RangeError('Invalid amount');
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    const result = await this.prisma.$transaction(async (tx) => {
      const photo = await tx.photo.findUnique({ where: { id: photoId } });
      const active = photo ? await findActiveDuel(tx, photoId) : null;
      if (!photo || !active) throw new DomainError('VOTING_CLOSED');
      const debited = await tx.user.updateMany({ where: { id: user.id, voteBalance: { gte: amount } }, data: { voteBalance: { decrement: amount } } });
      if (debited.count === 0) {
        const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        throw new DomainError('INSUFFICIENT_BALANCE', { balance: current.voteBalance });
      }
      const votes = await this.applyVotes(tx, photo, active.duel, active.side, user.id, amount, null);
      await this.activity.log({ action: 'PAID_VOTES_SPENT', userId: user.id, entityType: 'Photo', entityId: photoId, details: { amount, duelId: active.duel.id } }, tx);
      const { voteBalance } = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { voteBalance: true } });
      return { balance: voteBalance, votes, duelId: active.duel.id };
    });
    await this.scheduleOvertime();
    await this.scheduler.scheduleVoteRefresh(result.duelId);
    return { balance: result.balance, votes: result.votes };
  }

  /**
   * Refunds a Stars payment and takes back the purchased votes where still possible:
   * from a duel that is still being voted on, or from the remaining balance.
   * Votes already counted in a finished duel stay. Returns the number of votes taken back.
   */
  async refundStars(paymentId: number, adminUserId: number): Promise<{ payment: Payment; reclaimed: number }> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { user: true } });
    if (!payment || payment.status !== 'PAID' || !payment.telegramChargeId) throw new DomainError('INVALID_STATE');
    if (payment.method !== 'STARS') throw new DomainError('FORBIDDEN');

    await this.telegram.refundStarPayment(Number(payment.user.telegramId), payment.telegramChargeId);

    const result = await this.prisma.$transaction(async (tx) => {
      let reclaimed = 0;
      let duelId: number | null = null;
      const given = await tx.paidVote.findFirst({ where: { paymentId: payment.id }, include: { duel: true, photo: true } });
      if (given) {
        const stillOpen = given.duel.status === 'ACTIVE' && given.duel.stage === given.stage;
        if (stillOpen) {
          const sideVotes = votesOf(given.duel, given.side);
          reclaimed = Math.min(given.amount, sideVotes);
          if (reclaimed > 0) {
            await tx.duel.update({
              where: { id: given.duelId },
              data: { [VOTE_FIELD[given.side]]: { decrement: reclaimed } },
            });
            await tx.photo.update({ where: { id: given.photoId }, data: { votesCount: { decrement: reclaimed }, paidVotes: { decrement: reclaimed } } });
            await tx.user.update({ where: { id: given.photo.userId }, data: { votesReceived: { decrement: reclaimed } } });
            duelId = given.duelId;
          }
        }
      } else {
        const user = await tx.user.findUniqueOrThrow({ where: { id: payment.userId } });
        reclaimed = Math.min(payment.votes, user.voteBalance);
        if (reclaimed > 0) await tx.user.update({ where: { id: user.id }, data: { voteBalance: { decrement: reclaimed } } });
      }
      const refunded = await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', refundedAt: new Date() } });
      await this.activity.log(
        { action: 'PAYMENT_REFUNDED', userId: adminUserId, entityType: 'Payment', entityId: payment.id, details: { reclaimed } },
        tx,
      );
      return { payment: refunded, reclaimed, duelId };
    });
    if (result.duelId) await this.scheduler.scheduleVoteRefresh(result.duelId);
    return { payment: result.payment, reclaimed: result.reclaimed };
  }

  async getPayment(id: number) {
    return this.prisma.payment.findUnique({ where: { id }, include: { user: true } });
  }

  async listPayments(page: number, pageSize: number) {
    const where = { status: { in: ['PAID', 'REFUNDED'] as ('PAID' | 'REFUNDED')[] } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({ where, include: { user: true }, orderBy: { paidAt: 'desc' }, skip: page * pageSize, take: pageSize }),
      this.prisma.payment.count({ where }),
    ]);
    // Where the votes went: into a pair (which round/pair) or to the buyer's balance.
    const given = await this.prisma.paidVote.findMany({ where: { paymentId: { in: items.map((item) => item.id) } }, include: { duel: true } });
    const destination = new Map(given.map((vote) => [vote.paymentId!, { round: vote.duel.round, duel: vote.duel.position, side: sideNumber(vote.side) }]));
    return { items: items.map((item) => ({ ...item, destination: destination.get(item.id) ?? null })), total };
  }

  async stats(now: Date = new Date()): Promise<PaymentStats> {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const sum = async (method: PaymentMethod, since?: Date) =>
      (
        await this.prisma.payment.aggregate({
          where: { status: 'PAID', method, ...(since ? { paidAt: { gte: since } } : {}) },
          _sum: { amount: true },
        })
      )._sum.amount ?? 0;
    const sumCard = async (since?: Date) => (await sum('CARD', since)) + (await sum('TRANSFER', since));
    const [paid, paid24h, stars, cardTotal, card24h, votes] = await Promise.all([
      this.prisma.payment.count({ where: { status: 'PAID' } }),
      this.prisma.payment.count({ where: { status: 'PAID', paidAt: { gte: dayAgo } } }),
      sum('STARS'),
      sumCard(),
      sumCard(dayAgo),
      this.prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { votes: true } }),
    ]);
    return { paid, paid24h, stars, cardTotal, card24h, votesSold: votes._sum.votes ?? 0 };
  }

  // ---------------------------------------------------------------------------
  // Transfers to the owner's card / Monobank jar
  // ---------------------------------------------------------------------------

  /** Transfers are offered when enabled in the admin panel and the payment details are filled in. */
  async transferAvailable(): Promise<boolean> {
    const settings = await this.settings.get();
    return settings.paidVotesEnabled && settings.transferEnabled && !!settings.transferDetails;
  }

  /** Creates a transfer order with a unique code the buyer puts into the payment comment. */
  async createTransfer(user: User, packageId: number, targetPhotoId: number | null): Promise<{ payment: Payment; details: string; automatic: boolean }> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    const settings = await this.settings.get();
    if (!settings.paidVotesEnabled || !settings.transferEnabled || !settings.transferDetails) throw new DomainError('PAYMENTS_DISABLED');
    const pack = await this.prisma.votePackage.findUnique({ where: { id: packageId } });
    if (!pack?.isActive) throw new DomainError('NOT_FOUND');
    if (targetPhotoId !== null && !(await findActiveDuel(this.prisma, targetPhotoId))) throw new DomainError('VOTING_CLOSED');

    const expiresAt = new Date(Date.now() + this.options.transferTtlMinutes * 60_000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const payment = await this.prisma.payment.create({
          data: {
            userId: user.id,
            packageId: pack.id,
            votes: pack.votes + pack.bonusCard,
            method: 'TRANSFER',
            currency: this.options.cardCurrency,
            amount: pack.priceCard,
            targetPhotoId,
            code: generateCode(),
            expiresAt,
          },
        });
        await this.holdForPayment(targetPhotoId);
        return { payment, details: settings.transferDetails, automatic: this.bankVerification(settings) };
      } catch (error) {
        if (attempt >= 4 || (error as { code?: string }).code !== 'P2002') throw error;
      }
    }
  }

  /** A transfer order for a place in the final (price set by the admin, in minor units). */
  async createSpotTransfer(user: User, battleId: number): Promise<{ payment: Payment; details: string; automatic: boolean }> {
    if (user.isBlocked) throw new DomainError('USER_BLOCKED');
    const settings = await this.settings.get();
    if (!settings.transferEnabled || !settings.transferDetails) throw new DomainError('PAYMENTS_DISABLED');
    const expiresAt = new Date(Date.now() + this.options.transferTtlMinutes * 60_000);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const payment = await this.prisma.payment.create({
          data: {
            userId: user.id,
            votes: 0,
            method: 'TRANSFER',
            currency: this.options.cardCurrency,
            amount: settings.finalSpotPriceCard,
            finalSpotBattleId: battleId,
            code: generateCode(),
            expiresAt,
          },
        });
        return { payment, details: settings.transferDetails, automatic: this.bankVerification(settings) };
      } catch (error) {
        if (attempt >= 4 || (error as { code?: string }).code !== 'P2002') throw error;
      }
    }
  }

  /** Transfers for a place in the final are offered when transfers are on and the details are filled in. */
  async spotTransferAvailable(): Promise<boolean> {
    const settings = await this.settings.get();
    return settings.transferEnabled && !!settings.transferDetails;
  }

  /** The buyer says the transfer is done. Without bank verification the admins are asked right away. */
  async claimTransfer(paymentId: number, user: User): Promise<{ automatic: boolean; spot: boolean }> {
    const claimed = await this.prisma.payment.updateMany({
      // A buyer who paid a little after the time ran out can still press "I paid".
      where: { id: paymentId, userId: user.id, method: 'TRANSFER', OR: [{ status: 'PENDING' }, lateTransfers()] },
      data: { status: 'CLAIMED', claimedAt: new Date(), reviewRequestedAt: null },
    });
    if (claimed.count === 0) throw new DomainError('INVALID_STATE');
    const claimedOrder = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    await this.holdForPayment(claimedOrder.targetPhotoId);
    const settings = await this.settings.get();
    const automatic = this.bankVerification(settings);
    // With the bank check the bot confirms by itself and asks the admins only when it
    // finds nothing within a few minutes (see expireTransfers); without it, right away.
    if (automatic) {
      try {
        await this.pollBank();
      } catch (error) {
        this.logger.warn({ err: error }, 'Bank check on "I paid" failed');
        this.bankCheck = { at: new Date(), error: error instanceof Error ? error.message : String(error), items: 0 };
      }
    }
    // The admins are asked at once (unless the bank check has just found the transfer:
    // then the order is already paid and they get the "payment credited" note instead).
    await this.requestReview(paymentId);
    return { automatic, spot: claimedOrder.finalSpotBattleId !== null };
  }

  async cancelTransfer(paymentId: number, user: User): Promise<void> {
    const cancelled = await this.prisma.payment.updateMany({
      where: { id: paymentId, userId: user.id, method: 'TRANSFER', status: { in: ['PENDING', 'CLAIMED'] } },
      data: { status: 'CANCELLED' },
    });
    if (cancelled.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'PAYMENT_CANCELLED', userId: user.id, entityType: 'Payment', entityId: paymentId, details: { by: 'buyer' } });
  }

  /** Admin decision on a transfer that the bank check could not match. */
  async reviewTransfer(paymentId: number, adminUserId: number, approve: boolean): Promise<TransferOutcome> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { user: true } });
    const late = payment?.status === 'CANCELLED' && payment.confirmedById === null && Date.now() - payment.createdAt.getTime() < 24 * 60 * 60_000;
    if (payment?.method !== 'TRANSFER' || (payment.status !== 'PENDING' && payment.status !== 'CLAIMED' && !(approve && late))) throw new DomainError('INVALID_STATE');
    if (approve) {
      const completed = await this.credit(paymentId, { confirmedById: adminUserId });
      if (completed.alreadyProcessed) throw new DomainError('INVALID_STATE');
      await this.notifyPaid(payment.user, completed);
      return { kind: 'paid', completed, telegramId: payment.user.telegramId, languageCode: payment.user.languageCode };
    }
    const cancelled = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: { in: ['PENDING', 'CLAIMED'] } },
      data: { status: 'CANCELLED', confirmedById: adminUserId },
    });
    if (cancelled.count === 0) throw new DomainError('INVALID_STATE');
    await this.activity.log({ action: 'PAYMENT_CANCELLED', userId: adminUserId, entityType: 'Payment', entityId: paymentId, details: { by: 'admin' } });
    await this.notifications.notifyUser(payment.user, (l) => l.payments.transferRejected(payment.code ?? ''));
    return { kind: 'cancelled' };
  }

  /** Open transfers for the admin list (claimed first). */
  async openTransfers(limit: number) {
    return this.prisma.payment.findMany({
      where: { method: 'TRANSFER', status: { in: ['CLAIMED', 'PENDING'] } },
      include: { user: true },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
  }

  /**
   * Checks the Monobank statement for incoming transfers carrying an open
   * order's code and at least the order's amount, and credits them. Monobank allows one
   * statement request per minute, so calls closer than that are skipped.
   */
  async pollBank(now: Date = new Date()): Promise<number> {
    const settings = await this.settings.get();
    if (!this.bankVerification(settings)) return 0;
    if (now.getTime() - this.lastBankPoll < 60_000) return 0;

    const open = await this.prisma.payment.findMany({
      where: { code: { not: null }, OR: [{ method: 'TRANSFER', status: { in: ['PENDING', 'CLAIMED'] } }, lateTransfers(now)] },
      include: { user: true },
    });
    this.lastBankPoll = now.getTime();

    // Without open orders the last minutes are still read: unmatched transfers are reported to admins.
    const from = new Date(Math.min(now.getTime() - 15 * 60_000, ...open.map((payment) => payment.createdAt.getTime() - 5 * 60_000)));
    let items;
    try {
      items = await this.bank!.statement(settings.monobankAccountId!, from, now);
      this.bankCheck = { at: now, error: null, items: items.length };
    } catch (error) {
      if (!(error instanceof BankRateLimitError)) {
        this.logger.warn({ err: error }, 'Monobank statement request failed');
        const message = error instanceof Error ? error.message : String(error);
        this.bankCheck = { at: now, error: message, items: 0 };
        // Admins learn at once (at most hourly) that payments are not checked automatically.
        if (now.getTime() - this.lastBankAlert > 60 * 60_000) {
          this.lastBankAlert = now.getTime();
          await this.notifications.notifyAdmins((l) => l.admin.bankCheckFailing(message));
        }
      }
      return 0;
    }
    return this.matchBankItems(items, open);
  }

  /**
   * Monobank webhook: a new transaction on one of the owner's accounts. When it
   * lands on the selected jar/card and carries an open order's code, the votes
   * are credited at once (no waiting for the minute-by-minute check).
   */
  async handleBankWebhook(event: BankWebhookEvent): Promise<number> {
    const item = event.data?.statementItem;
    const settings = await this.settings.get();
    if (event.type !== 'StatementItem' || !item || !settings.bankAutoConfirm) return 0;
    const now = new Date();
    this.lastWebhookAt = now;
    const open = await this.prisma.payment.findMany({
      where: { code: { not: null }, OR: [{ method: 'TRANSFER', status: { in: ['PENDING', 'CLAIMED'] } }, lateTransfers(now)] },
      include: { user: true },
    });
    if (open.length === 0) return 0;
    // A transfer with an order's code is that order's, whichever of the owner's accounts
    // Monobank reports; matching by amount alone is only safe on the selected jar.
    const onSelected = !!settings.monobankAccountId && event.data?.account === settings.monobankAccountId;
    return this.matchBankItems([item], open, { byAmount: onSelected });
  }

  private lastBankAlert = 0;

  /** When Monobank last sent a transaction to the webhook (shown in "check the bank"). */
  lastWebhookAt: Date | null = null;

  /** Subscribes the bot to Monobank's instant notifications. */
  async connectBankWebhook(url: string): Promise<void> {
    if (!this.bank?.setWebhook) throw new DomainError('PAYMENTS_DISABLED');
    await this.bank.setWebhook(url);
  }

  /** The last automatic bank check: when, and what went wrong if anything. */
  bankCheck: { at: Date; error: string | null; items: number } | null = null;

  /**
   * Admin "check the bank now": reads the last day of the selected jar/card,
   * credits matching orders and shows what the bank returned.
   */
  async diagnoseBank(now: Date = new Date()): Promise<BankDiagnosis> {
    const settings = await this.settings.get();
    if (!this.bank) return { kind: 'no_token' };
    if (!settings.monobankAccountId) return { kind: 'no_account' };
    const wait = 60_000 - (now.getTime() - this.lastBankPoll);
    if (wait > 0) return { kind: 'wait', seconds: Math.ceil(wait / 1000) };
    this.lastBankPoll = now.getTime();
    let items;
    try {
      items = await this.bank.statement(settings.monobankAccountId, new Date(now.getTime() - 24 * 60 * 60_000), now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bankCheck = { at: now, error: message, items: 0 };
      return { kind: 'error', message };
    }
    this.bankCheck = { at: now, error: null, items: items.length };
    const open = await this.prisma.payment.findMany({
      where: { code: { not: null }, OR: [{ method: 'TRANSFER', status: { in: ['PENDING', 'CLAIMED'] } }, lateTransfers(now)] },
      include: { user: true },
    });
    const openCount = open.length;
    const credited = openCount > 0 ? await this.matchBankItems(items, open) : 0;
    const incoming = items
      .filter((item) => item.amount > 0)
      .slice(0, 5)
      .map((item) => ({ time: new Date(item.time * 1000), amount: item.amount, text: [item.description, item.comment].filter(Boolean).join(' · ') }));
    return { kind: 'ok', total: items.length, incoming, credited, open: openCount };
  }

  /** Credits open orders whose code is in an incoming transfer of at least their amount. */
  private async matchBankItems(items: BankStatementItem[], open: (Payment & { user: User })[], options: { byAmount?: boolean } = {}): Promise<number> {
    const currency = currencyNumericCode(this.options.cardCurrency);
    const incoming = items.filter((item) => item.amount > 0 && (currency === undefined || item.currencyCode === currency));
    const textOf = (item: BankStatementItem) => normalizeCode(`${item.description ?? ''} ${item.comment ?? ''}`);
    let credited = 0;
    // First every transfer with a code (exact), then the rest by amount — so a stranger's
    // transfer of the same amount cannot take the order of someone who entered the code.
    const passes = options.byAmount === false ? (['code'] as const) : (['code', 'amount'] as const);
    for (const pass of passes) {
      for (const item of incoming) {
        const text = textOf(item);
        const mentionsSomeCode = open.some((candidate) => text.includes(normalizeCode(candidate.code!)));
        const payment =
          pass === 'code'
            ? // The code identifies the order; paying a bit more than the pack price is fine too.
              open.find((candidate) => item.amount >= candidate.amount && text.includes(normalizeCode(candidate.code!)))
            : mentionsSomeCode
              ? undefined
              : matchByAmount(item, open);
        if (!payment) continue;
        if (await this.prisma.payment.findUnique({ where: { bankTransactionId: item.id }, select: { id: true } })) continue;
        try {
          const completed = await this.credit(payment.id, { bankTransactionId: item.id });
          if (completed.alreadyProcessed) continue;
          credited += 1;
          open.splice(open.indexOf(payment), 1);
          await this.notifyPaid(payment.user, completed);
          if (completed.payment.reviewRequestedAt) await this.notifications.notifyAdmins((l) => l.admin.transferAutoConfirmed(payment.code ?? ''));
        } catch (error) {
          // The same bank transaction cannot pay for two orders (unique bankTransactionId).
          if ((error as { code?: string }).code !== 'P2002') throw error;
        }
      }
    }
    if (options.byAmount !== false) {
      for (const item of incoming) await this.reportUnmatched(item);
    }
    return credited;
  }

  /**
   * A transfer on the selected jar that no order took: admins are told at once
   * (once per transaction), with buttons for the recent orders it may belong to.
   */
  private async reportUnmatched(item: BankStatementItem): Promise<void> {
    const paidAt = item.time * 1000;
    if (Date.now() - paidAt > 2 * 60 * 60_000) return;
    if (await this.prisma.payment.findUnique({ where: { bankTransactionId: item.id }, select: { id: true } })) return;
    if (await this.prisma.activityLog.findFirst({ where: { entityType: 'BankTx', entityId: item.id }, select: { id: true } })) return;
    await this.activity.log({ action: 'SETTINGS_UPDATED', entityType: 'BankTx', entityId: item.id, details: { amount: item.amount, unmatched: true } });
    const candidates = await this.prisma.payment.findMany({
      where: {
        method: 'TRANSFER',
        amount: { lte: item.amount },
        createdAt: { gte: new Date(paidAt - 60 * 60_000), lte: new Date(paidAt + 60_000) },
        OR: [{ status: { in: ['PENDING', 'CLAIMED'] } }, { status: 'CANCELLED', confirmedById: null }],
      },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 4,
    });
    const amount = formatCardPrice(item.amount, this.options.cardCurrency);
    const text = escapeHtml([item.description, item.comment].filter(Boolean).join(' · ') || '—');
    await this.notifications.notifyAdmins((l) => l.admin.unmatchedTransfer({ amount, text, orders: candidates.length }), {
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: candidates.map((order) => [
          {
            text: `✅ ${order.code} · ${order.user.username ? `@${order.user.username}` : order.user.firstName} · ${formatCardPrice(order.amount, order.currency)}`,
            callback_data: `a:tr:ok:${order.id}`,
          },
        ]),
      },
    });
  }

  /**
   * Housekeeping (every tick): unpaid orders expire; claimed transfers the bank
   * check could not match go to the admins; unanswered ones are cancelled.
   */
  async expireTransfers(now: Date = new Date()): Promise<void> {
    const expired = await this.prisma.payment.findMany({
      where: { method: 'TRANSFER', status: 'PENDING', expiresAt: { lt: now } },
      include: { user: true },
    });
    for (const payment of expired) {
      const done = await this.prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (done.count) await this.notifications.notifyUser(payment.user, (l) => l.payments.transferExpired(payment.code ?? ''));
    }

    const settings = await this.settings.get();
    if (this.bankVerification(settings)) {
      const unmatched = await this.prisma.payment.findMany({
        where: {
          method: 'TRANSFER',
          status: 'CLAIMED',
          reviewRequestedAt: null,
          claimedAt: { lt: new Date(now.getTime() - (this.options.reviewAfterMinutes ?? 5) * 60_000) },
        },
        select: { id: true },
      });
      for (const { id } of unmatched) await this.requestReview(id);
    }

    const unanswered = await this.prisma.payment.findMany({
      where: {
        method: 'TRANSFER',
        status: 'CLAIMED',
        reviewRequestedAt: { lt: new Date(now.getTime() - this.options.manualReviewHours * 60 * 60_000) },
      },
      include: { user: true },
    });
    for (const payment of unanswered) {
      const done = await this.prisma.payment.updateMany({ where: { id: payment.id, status: 'CLAIMED' }, data: { status: 'CANCELLED' } });
      if (done.count) await this.notifications.notifyUser(payment.user, (l) => l.payments.transferNotConfirmed(payment.code ?? ''));
    }
  }

  /** The bot confirms jar transfers itself: Monobank connected, a jar selected and auto-confirmation on. */
  private bankVerification(settings: { monobankAccountId: string | null; bankAutoConfirm: boolean }): boolean {
    return !!this.bank && !!settings.monobankAccountId && settings.bankAutoConfirm;
  }

  /** Asks admins to check a transfer manually (once). */
  private async requestReview(paymentId: number): Promise<void> {
    const marked = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: 'CLAIMED', reviewRequestedAt: null },
      data: { reviewRequestedAt: new Date() },
    });
    if (marked.count === 0) return;
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { user: true } });
    const amount = formatCardPrice(payment.amount, payment.currency);
    const buyer = payment.user.username ? `@${payment.user.username}` : payment.user.firstName;
    const spot = payment.finalSpotBattleId !== null;
    await this.notifications.notifyAdmins((l) => l.admin.transferReview({ id: payment.id, code: payment.code ?? '', amount, votes: payment.votes, buyer: escapeHtml(buyer), spot }), {
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '✅', callback_data: `a:tr:ok:${payment.id}` },
            { text: '❌', callback_data: `a:tr:no:${payment.id}` },
          ],
        ],
      },
    });
  }

  /** "💰 Payment: 20 ₴ (jar) — @user — 20 votes" for the admins. */
  private async announcePayment(payment: Payment, toEntry: boolean): Promise<void> {
    const buyer = await this.prisma.user.findUnique({ where: { id: payment.userId } });
    const who = escapeHtml(buyer ? (buyer.username ? `@${buyer.username}` : buyer.firstName) : '—');
    const amount = payment.method === 'STARS' ? `${payment.amount} ⭐` : formatCardPrice(payment.amount, payment.currency);
    await this.notifications.notifyAdmins((l) => l.admin.paymentReceived({ amount, method: l.admin.paymentMethods[payment.method], who, votes: payment.votes, toEntry }));
  }

  /** Admins: a place in the final was paid by transfer (or has to be paid back by hand). */
  private async announceSpot(payment: Payment, outcome: 'reserved' | 'unavailable'): Promise<void> {
    const buyer = await this.prisma.user.findUnique({ where: { id: payment.userId } });
    const who = escapeHtml(buyer ? [buyer.firstName, buyer.username ? `@${buyer.username}` : ''].filter(Boolean).join(' ') : '—');
    const amount = formatCardPrice(payment.amount, payment.currency);
    await this.notifications.notifyAdmins((l) => (outcome === 'reserved' ? l.admin.finalSpotSoldCard({ who, amount }) : l.admin.finalSpotPayBack({ who, amount, code: payment.code ?? '' })), {
      parseMode: 'HTML',
    });
  }

  private async notifyPaid(user: User, completed: CompletedPayment): Promise<void> {
    if (completed.finalSpot) {
      const amount = formatCardPrice(completed.payment.amount, completed.payment.currency);
      await this.notifications.notifyUser(user, (l) => (completed.finalSpot === 'reserved' ? l.finalSpot.reservedCard : l.finalSpot.soldOutCard(amount)), { parseMode: 'HTML' });
      return;
    }
    const votes = completed.payment.votes;
    // Votes on the balance while voting goes on: offer to give them right away.
    const targets = completed.creditedTo === 'balance' ? await this.voteTargets() : [];
    await this.notifications.notifyUser(
      user,
      (l) =>
        (completed.creditedTo === 'photo'
          ? l.payments.paidToPhoto(votes)
          : completed.targetUnavailable
            ? l.payments.paidPhotoGone({ votes, balance: completed.balance })
            : l.payments.paidToBalance({ votes, balance: completed.balance })) + (targets.length > 0 ? `\n\n${l.payments.giveNow}` : ''),
      { parseMode: 'HTML', ...(targets.length > 0 ? { replyMarkup: voteTargetsKeyboard(targets) } : {}) },
    );
  }

  /** Pairs (and challenge photos) open for voting right now: where balance votes can go. */
  async voteTargets(): Promise<{ duelId: number; label: string }[]> {
    const duels = await this.prisma.duel.findMany({
      where: { status: 'ACTIVE', endsAt: { gt: new Date() }, battle: { status: 'RUNNING' } },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
      take: 12,
    });
    return duels.map((duel) => ({ duelId: duel.id, label: duel.goal !== null ? `🎯 ${duel.goal}` : duel.photoCId !== null ? '🏆' : `⚔️ ${duel.position}` }));
  }

  /** A user's payments and the balance votes they gave (admin view). */
  async userHistory(userId: number) {
    const payments = await this.prisma.payment.findMany({
      where: { userId, status: { in: ['PAID', 'REFUNDED', 'CLAIMED', 'PENDING'] } },
      orderBy: { id: 'desc' },
      take: 15,
    });
    const given = await this.prisma.paidVote.findMany({ where: { userId }, include: { duel: true }, orderBy: { id: 'desc' }, take: 30 });
    const destination = new Map(given.filter((v) => v.paymentId !== null).map((v) => [v.paymentId!, { round: v.duel.round, duel: v.duel.position, side: sideNumber(v.side) }]));
    return {
      payments: payments.map((payment) => ({ ...payment, destination: destination.get(payment.id) ?? null })),
      spent: given.filter((v) => v.paymentId === null).map((v) => ({ amount: v.amount, at: v.createdAt, round: v.duel.round, duel: v.duel.position, side: sideNumber(v.side) })),
    };
  }

  /** Adds paid votes to the entry's side of its current duel stage. Returns that side's new count. */
  private async applyVotes(
    tx: Prisma.TransactionClient,
    photo: Photo,
    duel: Duel,
    side: DuelSide,
    buyerId: number,
    amount: number,
    paymentId: number | null,
  ): Promise<number> {
    const updated = await tx.duel.update({
      where: { id: duel.id },
      data: { [VOTE_FIELD[side]]: { increment: amount } },
      select: VOTE_SELECT,
    });
    // Overtime: paid votes in the last minutes give the other side time to answer.
    await this.extendNearEnd(tx, duel);
    await tx.photo.update({ where: { id: photo.id }, data: { votesCount: { increment: amount }, paidVotes: { increment: amount } } });
    await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: amount } } });
    await tx.paidVote.create({ data: { photoId: photo.id, duelId: duel.id, stage: duel.stage, side, userId: buyerId, amount, paymentId } });
    return votesOf(updated, side);
  }
}

/** Buttons "⚔️ 1  ⚔️ 2 … 🏆" that open a pair to give balance votes (handled as pay:pick). */
export function voteTargetsKeyboard(targets: { duelId: number; label: string }[]): InlineKeyboardMarkup {
  const buttons = targets.map((target) => ({ text: target.label, callback_data: `pay:pick:${target.duelId}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return { inline_keyboard: rows };
}

/** Without a code a transfer may still be matched by its exact amount, only when that is unambiguous. */
const AMOUNT_MATCH_WINDOW_MS = 30 * 60_000;

/**
 * A transfer without a code: the open order of exactly this amount made in the
 * last 30 minutes before it. With several such orders the one whose buyer
 * already pressed "I paid" wins if it is the only one; otherwise nobody (admins decide).
 */
function matchByAmount<T extends Payment>(item: BankStatementItem, open: T[]): T | undefined {
  const paidAt = item.time * 1000;
  const candidates = open.filter(
    (order) =>
      order.method === 'TRANSFER' &&
      // Expired (not admin-rejected) orders count too: people often pay a few minutes late.
      (order.status === 'PENDING' || order.status === 'CLAIMED' || (order.status === 'CANCELLED' && order.confirmedById === null)) &&
      order.amount === item.amount &&
      order.createdAt.getTime() <= paidAt + 60_000 &&
      order.createdAt.getTime() >= paidAt - AMOUNT_MATCH_WINDOW_MS,
  );
  if (candidates.length === 1) return candidates[0];
  const claimed = candidates.filter((order) => order.status === 'CLAIMED');
  return claimed.length === 1 ? claimed[0] : undefined;
}

function generateCode(): string {
  let code = 'PB';
  for (let i = 0; i < 5; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Codes are matched ignoring case, spaces and dashes ("pb-7k2 q9" matches "PB7K2Q9"). */
function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[\s\-_.]/g, '');
}

export { formatCardPrice } from '../../lib/format.js';
