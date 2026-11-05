import type { Duel, DuelSide, Payment, PaymentMethod, Photo, Prisma, PrismaClient, User, VotePackage } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { JobScheduler, TelegramGateway } from '../contracts.js';
import type { SettingsService } from '../settings/settings.service.js';

export const STARS_CURRENCY = 'XTR';
const PAYLOAD_PREFIX = 'order:';
/** Invoices older than this are refused at checkout. */
const ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default packs created on first start; admins can change prices or hide packs. */
export const DEFAULT_PACKAGES = [
  { votes: 5, priceStars: 25, priceCard: 2500, sortOrder: 1 },
  { votes: 20, priceStars: 90, priceCard: 8900, sortOrder: 2 },
  { votes: 50, priceStars: 200, priceCard: 19900, sortOrder: 3 },
] as const;

export interface PaymentOptions {
  cardEnabled: boolean;
  cardCurrency: string;
}

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
    where: { status: 'ACTIVE', endsAt: { gt: now }, OR: [{ photoAId: photoId }, { photoBId: photoId }] },
  });
  if (!duel) return null;
  return { duel, side: duel.photoAId === photoId ? 'A' : 'B' };
}

export interface CompletedPayment {
  payment: Payment;
  /** 'photo' — votes went to the target entry's current duel; 'balance' — to the buyer's balance. */
  creditedTo: 'photo' | 'balance';
  /** Set when the target photo was no longer votable and votes went to the balance instead. */
  targetUnavailable: boolean;
  balance: number;
  alreadyProcessed: boolean;
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
  ) {}

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
    if (!Number.isInteger(priceCard) || priceCard < 100 || priceCard > 100_000_000) throw new RangeError('Invalid card price');
    const pack = await this.prisma.votePackage.update({ where: { id }, data: { priceStars, priceCard } });
    await this.activity.log({ action: 'PACKAGE_UPDATED', userId: adminUserId, entityType: 'VotePackage', entityId: id, details: { priceStars, priceCard } });
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
    if (!pack?.isActive) throw new DomainError('NOT_FOUND');
    if (targetPhotoId !== null && !(await findActiveDuel(this.prisma, targetPhotoId))) throw new DomainError('VOTING_CLOSED');
    const currency = method === 'STARS' ? STARS_CURRENCY : this.options.cardCurrency;
    const amount = method === 'STARS' ? pack.priceStars : pack.priceCard;
    const payment = await this.prisma.payment.create({
      data: { userId: user.id, packageId: pack.id, votes: pack.votes, method, currency, amount, targetPhotoId },
    });
    return { payment, payload: orderPayload(payment.id), currency, amount, votes: pack.votes };
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

    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id }, include: { user: true } });
      if (payment.user.telegramId !== BigInt(input.telegramUserId)) throw new Error(`Payment ${id} belongs to another user`);
      if (payment.status !== 'PENDING') {
        return { payment, creditedTo: 'balance' as const, targetUnavailable: false, balance: payment.user.voteBalance, alreadyProcessed: true, duelId: null };
      }
      if (payment.currency !== input.currency || payment.amount !== input.totalAmount) {
        this.logger.error({ paymentId: id, expected: [payment.currency, payment.amount], got: [input.currency, input.totalAmount] }, 'Paid amount differs from the order');
      }
      const paid = await tx.payment.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date(), telegramChargeId: input.telegramChargeId, providerChargeId: input.providerChargeId || null },
      });

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
          entityId: id,
          details: { method: payment.method, amount: payment.amount, currency: payment.currency, votes: payment.votes, creditedTo },
        },
        tx,
      );
      return { payment: paid, creditedTo, targetUnavailable, balance, alreadyProcessed: false, duelId };
    });

    if (result.duelId) await this.scheduler.scheduleVoteRefresh(result.duelId);
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
          const sideVotes = given.side === 'A' ? given.duel.votesA : given.duel.votesB;
          reclaimed = Math.min(given.amount, sideVotes);
          if (reclaimed > 0) {
            await tx.duel.update({
              where: { id: given.duelId },
              data: given.side === 'A' ? { votesA: { decrement: reclaimed } } : { votesB: { decrement: reclaimed } },
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
    return { items, total };
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
    const [paid, paid24h, stars, cardTotal, card24h, votes] = await Promise.all([
      this.prisma.payment.count({ where: { status: 'PAID' } }),
      this.prisma.payment.count({ where: { status: 'PAID', paidAt: { gte: dayAgo } } }),
      sum('STARS'),
      sum('CARD'),
      sum('CARD', dayAgo),
      this.prisma.payment.aggregate({ where: { status: 'PAID' }, _sum: { votes: true } }),
    ]);
    return { paid, paid24h, stars, cardTotal, card24h, votesSold: votes._sum.votes ?? 0 };
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
      data: side === 'A' ? { votesA: { increment: amount } } : { votesB: { increment: amount } },
      select: { votesA: true, votesB: true },
    });
    await tx.photo.update({ where: { id: photo.id }, data: { votesCount: { increment: amount }, paidVotes: { increment: amount } } });
    await tx.user.update({ where: { id: photo.userId }, data: { votesReceived: { increment: amount } } });
    await tx.paidVote.create({ data: { photoId: photo.id, duelId: duel.id, stage: duel.stage, side, userId: buyerId, amount, paymentId } });
    return side === 'A' ? updated.votesA : updated.votesB;
  }
}

/** Formats a card price stored in minor units: 8900 UAH → "89 ₴". */
export function formatCardPrice(amount: number, currency: string): string {
  const value = amount / 100;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return currency === 'UAH' ? `${text} ₴` : `${text} ${currency}`;
}
