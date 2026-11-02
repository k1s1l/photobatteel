import { beforeEach, describe, expect, it } from 'vitest';
import { orderPayload } from '../../src/modules/payments/payment.service.js';
import { createAdmin, createQueuedPhoto, createTestContext, createUser, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  await ctx.services.settings.update({ paidVotesEnabled: true, maxQueuedPerUser: 0, maxPhotosPerDay: 0 }, null);
});

async function publishedPhoto(owner: Awaited<ReturnType<typeof createUser>>) {
  const photo = await createQueuedPhoto(ctx, owner);
  await ctx.services.publications.processItem((await ctx.services.publications.claimNext())!.id);
  return photo;
}

async function pay(invoice: { payload: string; currency: string; amount: number }, telegramUserId: number, chargeId = `charge-${invoice.payload}`) {
  return ctx.services.payments.completePayment({
    payload: invoice.payload,
    telegramUserId,
    currency: invoice.currency,
    totalAmount: invoice.amount,
    telegramChargeId: chargeId,
    providerChargeId: '',
  });
}

describe('vote packages', () => {
  it('creates default packages once and lets admins change prices and visibility', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.payments.ensureDefaultPackages();
    const packs = await ctx.services.payments.listPackages(true);
    expect(packs.map((p) => p.votes)).toEqual([5, 20, 50]);
    await ctx.services.payments.updatePackagePrice(packs[0]!.id, 30, 3500, admin.id);
    expect(await ctx.services.payments.getPackage(packs[0]!.id)).toMatchObject({ priceStars: 30, priceCard: 3500 });
    await ctx.services.payments.togglePackage(packs[0]!.id, admin.id);
    expect(await ctx.services.payments.listPackages(true)).toHaveLength(2);
    await expect(ctx.services.payments.updatePackagePrice(packs[1]!.id, 0, 100, admin.id)).rejects.toThrow(RangeError);
  });
});

describe('buying votes', () => {
  it('creates Stars and card invoices with the package price', async () => {
    const buyer = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const stars = await ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', null);
    expect(stars).toMatchObject({ currency: 'XTR', amount: pack!.priceStars, votes: 5, payload: orderPayload(stars.payment.id) });
    const card = await ctx.services.payments.createInvoice(buyer, pack!.id, 'CARD', null);
    expect(card).toMatchObject({ currency: 'UAH', amount: pack!.priceCard });
  });

  it('refuses invoices when sales are disabled', async () => {
    await ctx.services.settings.update({ paidVotesEnabled: false }, null);
    const buyer = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    await expect(ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', null)).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
  });

  it('validates the pre-checkout query against the order', async () => {
    const buyer = await createUser(ctx);
    const other = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', null);
    const base = { payload: invoice.payload, telegramUserId: Number(buyer.telegramId), currency: 'XTR', totalAmount: invoice.amount };
    expect(await ctx.services.payments.validateCheckout(base)).toBeNull();
    expect(await ctx.services.payments.validateCheckout({ ...base, totalAmount: 1 })).toBe('expired');
    expect(await ctx.services.payments.validateCheckout({ ...base, telegramUserId: Number(other.telegramId) })).toBe('expired');
    expect(await ctx.services.payments.validateCheckout({ ...base, payload: 'order:999999' })).toBe('expired');
    await ctx.services.settings.update({ paidVotesEnabled: false }, null);
    expect(await ctx.services.payments.validateCheckout(base)).toBe('disabled');
  });

  it('credits votes to the balance exactly once per Telegram charge', async () => {
    const buyer = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', null);
    const first = await pay(invoice, Number(buyer.telegramId));
    expect(first).toMatchObject({ creditedTo: 'balance', balance: 5, alreadyProcessed: false });
    const again = await pay(invoice, Number(buyer.telegramId));
    expect(again.alreadyProcessed).toBe(true);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).voteBalance).toBe(5);
    expect(await ctx.services.payments.validateCheckout({ payload: invoice.payload, telegramUserId: Number(buyer.telegramId), currency: 'XTR', totalAmount: invoice.amount })).toBe('expired');
  });

  it('applies votes bought for a specific photo directly to it', async () => {
    const owner = await createUser(ctx);
    const fan = await createUser(ctx);
    const photo = await publishedPhoto(owner);
    const packs = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, packs[1]!.id, 'CARD', photo.id);
    const result = await pay(invoice, Number(fan.telegramId));
    expect(result.creditedTo).toBe('photo');
    expect(await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ votesCount: 20, paidVotes: 20 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).votesReceived).toBe(20);
    expect(ctx.scheduler.voteRefreshes).toContain(photo.id);
  });

  it('puts votes on the balance if the target photo disappeared before payment completed', async () => {
    const owner = await createUser(ctx);
    const fan = await createUser(ctx);
    const photo = await publishedPhoto(owner);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, pack!.id, 'STARS', photo.id);
    await ctx.services.photos.delete(photo.id, { userId: owner.id, isAdmin: false });
    const result = await pay(invoice, Number(fan.telegramId));
    expect(result).toMatchObject({ creditedTo: 'balance', targetUnavailable: true, balance: 5 });
  });
});

describe('spending purchased votes', () => {
  it('spends votes from the balance on any published photo, including your own', async () => {
    const user = await createUser(ctx);
    const photo = await publishedPhoto(user);
    const [pack] = await ctx.services.payments.listPackages(true);
    await pay(await ctx.services.payments.createInvoice(user, pack!.id, 'STARS', null), Number(user.telegramId));
    const fresh = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(await ctx.services.payments.spendVotes(fresh, photo.id, 3)).toEqual({ balance: 2, votes: 3 });
    await expect(ctx.services.payments.spendVotes(fresh, photo.id, 3)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', params: { balance: 2 } });
    expect(await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ votesCount: 3, paidVotes: 3 });
  });

  it('never lets concurrent spending go below zero', async () => {
    const user = await createUser(ctx);
    const photo = await publishedPhoto(await createUser(ctx));
    await ctx.prisma.user.update({ where: { id: user.id }, data: { voteBalance: 3 } });
    const fresh = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => ctx.services.payments.spendVotes(fresh, photo.id, 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).voteBalance).toBe(0);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).votesCount).toBe(3);
  });
});

describe('refunds and statistics', () => {
  it('refunds a Stars payment and takes the votes back', async () => {
    const admin = await createAdmin(ctx);
    const owner = await createUser(ctx);
    const fan = await createUser(ctx);
    const photo = await publishedPhoto(owner);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, pack!.id, 'STARS', photo.id);
    await pay(invoice, Number(fan.telegramId), 'tg-charge-1');

    const { reclaimed, payment } = await ctx.services.payments.refundStars(invoice.payment.id, admin.id);
    expect(reclaimed).toBe(5);
    expect(payment.status).toBe('REFUNDED');
    expect(ctx.telegram.callsOf('refundStarPayment')[0]).toMatchObject({ chatId: Number(fan.telegramId), args: ['tg-charge-1'] });
    expect(await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).toMatchObject({ votesCount: 0, paidVotes: 0 });
    await expect(ctx.services.payments.refundStars(invoice.payment.id, admin.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('summarizes revenue by method', async () => {
    const buyer = await createUser(ctx);
    const [small, medium] = await ctx.services.payments.listPackages(true);
    await pay(await ctx.services.payments.createInvoice(buyer, small!.id, 'STARS', null), Number(buyer.telegramId));
    await pay(await ctx.services.payments.createInvoice(buyer, medium!.id, 'CARD', null), Number(buyer.telegramId));
    await ctx.services.payments.createInvoice(buyer, medium!.id, 'CARD', null); // unpaid
    expect(await ctx.services.payments.stats()).toMatchObject({ paid: 2, stars: 25, cardTotal: 8900, votesSold: 25 });
  });
});
