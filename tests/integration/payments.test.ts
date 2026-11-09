import { beforeEach, describe, expect, it } from 'vitest';
import type { Duel } from '../../src/generated/prisma/client.js';
import { orderPayload } from '../../src/modules/payments/payment.service.js';
import { createAdmin, createEntry, createTestContext, createUser, expireDuels, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  await ctx.services.settings.update({ paidVotesEnabled: true }, null);
});

/** A running battle with one active duel. */
async function activeDuel(): Promise<Duel> {
  const battle = await openBattle(ctx);
  await createEntry(ctx, await createUser(ctx));
  await createEntry(ctx, await createUser(ctx));
  await startBattle(ctx, battle.id);
  await postPendingDuels(ctx);
  return ctx.prisma.duel.findFirstOrThrow();
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

describe('buying votes for a duel side', () => {
  it('creates Stars and card invoices and refuses entries that are not being voted on', async () => {
    const duel = await activeDuel();
    const buyer = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const stars = await ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', duel.photoAId);
    expect(stars).toMatchObject({ currency: 'XTR', amount: pack!.priceStars, votes: 5, payload: orderPayload(stars.payment.id) });
    expect(await ctx.services.payments.createInvoice(buyer, pack!.id, 'CARD', null)).toMatchObject({ currency: 'UAH', amount: pack!.priceCard });
    await expireDuels(ctx);
    await expect(ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', duel.photoAId)).rejects.toMatchObject({ code: 'VOTING_CLOSED' });
  });

  it('validates pre-checkout against the order', async () => {
    const buyer = await createUser(ctx);
    const other = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(buyer, pack!.id, 'STARS', null);
    const base = { payload: invoice.payload, telegramUserId: Number(buyer.telegramId), currency: 'XTR', totalAmount: invoice.amount };
    expect(await ctx.services.payments.validateCheckout(base)).toBeNull();
    expect(await ctx.services.payments.validateCheckout({ ...base, totalAmount: 1 })).toBe('expired');
    expect(await ctx.services.payments.validateCheckout({ ...base, telegramUserId: Number(other.telegramId) })).toBe('expired');
    await ctx.services.settings.update({ paidVotesEnabled: false }, null);
    expect(await ctx.services.payments.validateCheckout(base)).toBe('disabled');
  });

  it('adds purchased votes to the chosen side of the current duel, exactly once', async () => {
    const duel = await activeDuel();
    const fan = await createUser(ctx);
    const packs = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, packs[1]!.id, 'CARD', duel.photoBId);
    const result = await pay(invoice, Number(fan.telegramId));
    expect(result.creditedTo).toBe('photo');
    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).toMatchObject({ votesA: 0, votesB: 20 });
    expect(await ctx.prisma.photo.findUniqueOrThrow({ where: { id: duel.photoBId! } })).toMatchObject({ votesCount: 20, paidVotes: 20 });
    expect(ctx.scheduler.voteRefreshes).toContain(duel.id);
    expect((await pay(invoice, Number(fan.telegramId))).alreadyProcessed).toBe(true);
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesB).toBe(20);
  });

  it('puts votes on the balance when the duel ended before the payment completed', async () => {
    const duel = await activeDuel();
    const fan = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, pack!.id, 'STARS', duel.photoAId);
    await expireDuels(ctx);
    expect(await pay(invoice, Number(fan.telegramId))).toMatchObject({ creditedTo: 'balance', targetUnavailable: true, balance: 5 });
  });

  it('spends balance votes on a side and never goes below zero', async () => {
    const duel = await activeDuel();
    const user = await createUser(ctx);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { voteBalance: 3 } });
    const fresh = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => ctx.services.payments.spendVotes(fresh, duel.photoAId, 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).voteBalance).toBe(0);
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesA).toBe(3);
    await expect(ctx.services.payments.spendVotes(fresh, duel.photoAId, 1)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
});

describe('overtime', () => {
  it('extends a pair to 5 minutes from now when paid votes come in the last minutes', async () => {
    const duel = await activeDuel();
    const user = await createUser(ctx);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { voteBalance: 5 } });
    const fresh = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    // Plenty of time left: nothing changes.
    await ctx.services.payments.spendVotes(fresh, duel.photoAId, 1);
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).endsAt).toEqual(duel.endsAt);

    // One minute left: voting now ends 5 minutes from the paid vote, and a tick is scheduled then.
    await ctx.prisma.duel.update({ where: { id: duel.id }, data: { endsAt: new Date(Date.now() + 60_000) } });
    const before = Date.now();
    await ctx.services.payments.spendVotes(fresh, duel.photoBId!, 1);
    const extended = (await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).endsAt!.getTime();
    expect(extended).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(extended).toBeLessThan(before + 5 * 60_000 + 5_000);
    expect(ctx.scheduler.timedTicks.at(-1)!.at.getTime()).toBe(extended);

    // A tick at the old end does not close the pair.
    await ctx.services.battles.tick(new Date(before + 2 * 60_000));
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('ACTIVE');
  });
});

describe('refunds and statistics', () => {
  it('refunds Stars and takes back votes from a duel that is still open', async () => {
    const admin = await createAdmin(ctx);
    const duel = await activeDuel();
    const fan = await createUser(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    const invoice = await ctx.services.payments.createInvoice(fan, pack!.id, 'STARS', duel.photoAId);
    await pay(invoice, Number(fan.telegramId), 'tg-charge-1');

    const { reclaimed, payment } = await ctx.services.payments.refundStars(invoice.payment.id, admin.id);
    expect(reclaimed).toBe(5);
    expect(payment.status).toBe('REFUNDED');
    expect(ctx.telegram.callsOf('refundStarPayment')[0]).toMatchObject({ chatId: Number(fan.telegramId), args: ['tg-charge-1'] });
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesA).toBe(0);
    await expect(ctx.services.payments.refundStars(invoice.payment.id, admin.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('does not allow a card price below 10 UAH (Monobank minimum)', async () => {
    const admin = await createAdmin(ctx);
    const [pack] = await ctx.services.payments.listPackages(true);
    expect(pack).toMatchObject({ votes: 5, priceCard: 1000 });
    await expect(ctx.services.payments.updatePackagePrice(pack!.id, 5, 900, admin.id)).rejects.toBeInstanceOf(RangeError);
    expect(await ctx.services.payments.updatePackagePrice(pack!.id, 5, 1000, admin.id)).toMatchObject({ priceCard: 1000 });
  });

  it('summarizes revenue by method', async () => {
    const buyer = await createUser(ctx);
    const [small, medium] = await ctx.services.payments.listPackages(true);
    await pay(await ctx.services.payments.createInvoice(buyer, small!.id, 'STARS', null), Number(buyer.telegramId));
    await pay(await ctx.services.payments.createInvoice(buyer, medium!.id, 'CARD', null), Number(buyer.telegramId));
    await ctx.services.payments.createInvoice(buyer, medium!.id, 'CARD', null); // unpaid
    expect(await ctx.services.payments.stats()).toMatchObject({ paid: 2, stars: 5, cardTotal: 2000, votesSold: 25 });
  });
});
