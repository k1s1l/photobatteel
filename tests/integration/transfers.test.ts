import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/generated/prisma/client.js';
import type { BankClient, BankStatementItem } from '../../src/modules/payments/monobank.js';
import { ADMIN_TG_ID, createAdmin, createEntry, createTestContext, createUser, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';

class FakeBank implements BankClient {
  items: BankStatementItem[] = [];
  statementCalls = 0;
  async listAccounts() {
    return [{ id: 'jar1', kind: 'jar' as const, label: 'Батли · UAH', currencyCode: 980, sendLink: 'https://send.monobank.ua/jar/X' }];
  }
  async statement() {
    this.statementCalls += 1;
    return this.items;
  }
}

let ctx: TestContext;
let bank: FakeBank;
let buyer: User;

async function enableTransfers(withBank: boolean) {
  await ctx.services.settings.update(
    { paidVotesEnabled: true, transferEnabled: true, transferDetails: '5375 4141 0000 0000', ...(withBank ? { monobankAccountId: 'jar1' } : {}) },
    null,
  );
}

const dmTo = (user: User) => ctx.telegram.callsOf('sendMessage').filter((c) => c.chatId === Number(user.telegramId)).map((c) => String(c.args[0]));
const adminTexts = () => ctx.telegram.callsOf('sendMessage').filter((c) => c.chatId === ADMIN_TG_ID).map((c) => String(c.args[0]));

describe('transfer orders', () => {
  beforeEach(async () => {
    bank = new FakeBank();
    ctx = await createTestContext({ bank });
    buyer = await createUser(ctx);
  });

  it('are offered only when enabled with payment details', async () => {
    const [pack] = await ctx.services.payments.listPackages(true);
    await ctx.services.settings.update({ paidVotesEnabled: true }, null);
    expect(await ctx.services.payments.transferAvailable()).toBe(false);
    await expect(ctx.services.payments.createTransfer(buyer, pack!.id, null)).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
    await enableTransfers(false);
    expect(await ctx.services.payments.transferAvailable()).toBe(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    expect(order.payment).toMatchObject({ method: 'TRANSFER', status: 'PENDING', currency: 'UAH', amount: pack!.priceCard, votes: 10 });
    expect(order.payment.code).toMatch(/^PB[A-Z2-9]{5}$/);
    expect(order.details).toBe('5375 4141 0000 0000');
    expect(order.automatic).toBe(false);
  });

  it('without bank verification: claim → admins review → votes credited once', async () => {
    await createAdmin(ctx);
    await enableTransfers(false);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    expect(await ctx.services.payments.claimTransfer(order.payment.id, buyer)).toEqual({ automatic: false });
    expect(adminTexts().some((t) => t.includes('Проверь перевод') && t.includes(order.payment.code!))).toBe(true);
    await expect(ctx.services.payments.claimTransfer(order.payment.id, buyer)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { telegramId: BigInt(ADMIN_TG_ID) } });
    const result = await ctx.services.payments.reviewTransfer(order.payment.id, admin.id, true);
    expect(result.kind).toBe('paid');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).voteBalance).toBe(10);
    expect(dmTo(buyer).some((t) => t.includes('На баланс зачислено 10'))).toBe(true);
    await expect(ctx.services.payments.reviewTransfer(order.payment.id, admin.id, true)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).voteBalance).toBe(10);
  });

  it('an admin can reject a transfer', async () => {
    const admin = await createAdmin(ctx);
    await enableTransfers(false);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    await ctx.services.payments.claimTransfer(order.payment.id, buyer);
    expect((await ctx.services.payments.reviewTransfer(order.payment.id, admin.id, false)).kind).toBe('cancelled');
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } })).status).toBe('CANCELLED');
    expect(dmTo(buyer).some((t) => t.includes('не найден'))).toBe(true);
  });

  it('with Monobank: finds the transfer by code and amount and credits the chosen side of the duel', async () => {
    await enableTransfers(true);
    const battle = await openBattle(ctx);
    await createEntry(ctx, await createUser(ctx));
    await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    const packs = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, packs[1]!.id, duel.photoBId);
    expect(order.automatic).toBe(true);

    const code = order.payment.code!;
    const typed = `${code.slice(0, 2).toLowerCase()}-${code.slice(2)}`; // the buyer typed "pb-XXXXX"
    bank.items = [
      { id: 'other', time: 1, amount: order.payment.amount, currencyCode: 980, description: 'Від: Іван', comment: 'без коду' },
      { id: 'wrong-sum', time: 2, amount: 100, currencyCode: 980, description: 'Від: Петро', comment: code },
      { id: 'tx-1', time: 3, amount: order.payment.amount, currencyCode: 980, description: 'Від: Олена', comment: `оплата ${typed}` },
    ];
    expect(await ctx.services.payments.pollBank()).toBe(1);
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } })).toMatchObject({ status: 'PAID', bankTransactionId: 'tx-1' });
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesB).toBe(20);
    expect(dmTo(buyer).some((t) => t.includes('Работа получила +20'))).toBe(true);
    expect(adminTexts().some((t) => t.includes('подтверждена автоматически'))).toBe(false); // nobody pressed "I paid"

    expect(ctx.scheduler.voteRefreshes).toContain(duel.id);
  });

  it('gives 5 minutes to pay and still accepts a transfer that arrives a bit later', async () => {
    await createAdmin(ctx);
    await enableTransfers(true);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    expect(order.payment.expiresAt!.getTime() - order.payment.createdAt.getTime()).toBeLessThanOrEqual(5 * 60_000 + 1000);

    await ctx.services.payments.expireTransfers(new Date(Date.now() + 6 * 60_000));
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } })).status).toBe('CANCELLED');

    // The money arrives after the order expired: the bank check still finds it.
    bank.items = [{ id: 'late-1', time: 1, amount: order.payment.amount, currencyCode: 980, description: 'Від: Олена', comment: order.payment.code! }];
    expect(await ctx.services.payments.pollBank()).toBe(1);
    expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } })).toMatchObject({ status: 'PAID', bankTransactionId: 'late-1' });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).voteBalance).toBe(10);
  });

  it('lets the buyer press "I paid" after the time ran out, but not after an admin rejected it', async () => {
    await createAdmin(ctx);
    await enableTransfers(false);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    await ctx.services.payments.expireTransfers(new Date(Date.now() + 6 * 60_000));
    expect(await ctx.services.payments.claimTransfer(order.payment.id, buyer)).toEqual({ automatic: false });
    expect(adminTexts().some((t) => t.includes(order.payment.code!))).toBe(true);

    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { telegramId: BigInt(ADMIN_TG_ID) } });
    await ctx.services.payments.reviewTransfer(order.payment.id, admin.id, false);
    await expect(ctx.services.payments.claimTransfer(order.payment.id, buyer)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('asks the admins as soon as the buyer presses "I paid" and tells them when the bank confirmed it', async () => {
    await createAdmin(ctx);
    await enableTransfers(true);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    await ctx.services.payments.claimTransfer(order.payment.id, buyer);
    expect(adminTexts().some((t) => t.includes('Проверь перевод') && t.includes(order.payment.code!))).toBe(true);
    bank.items = [{ id: 'tx-fast', time: 1, amount: order.payment.amount, currencyCode: 980, description: 'Від: Олена', comment: order.payment.code! }];
    expect(await ctx.services.payments.pollBank(new Date(Date.now() + 61_000))).toBe(1);
    expect(adminTexts().some((t) => t.includes('подтверждена автоматически') && t.includes(order.payment.code!))).toBe(true);
  });

  it('keeps a pair open while a card transfer for it waits for the admin, so the votes count in the pair', async () => {
    await createAdmin(ctx);
    await enableTransfers(false);
    const battle = await openBattle(ctx);
    await createEntry(ctx, await createUser(ctx));
    await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, duel.photoBId);
    await ctx.services.payments.claimTransfer(order.payment.id, buyer);

    // Time is up, but the transfer is not confirmed yet: the pair stays open and the admins are reminded.
    await ctx.prisma.duel.update({ where: { id: duel.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    await ctx.services.battles.tick();
    const held = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(held.status).toBe('ACTIVE');
    expect(held.endsAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(adminTexts().some((t) => t.includes('ждёт подтверждения перевод') && t.includes(order.payment.code!))).toBe(true);

    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { telegramId: BigInt(ADMIN_TG_ID) } });
    await ctx.services.payments.reviewTransfer(order.payment.id, admin.id, true);
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesB).toBe(pack!.votes);

    // With nothing pending the pair closes as usual.
    await ctx.prisma.duel.update({ where: { id: duel.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    await ctx.services.battles.tick();
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('FINISHED');
  });

  it('stops holding a pair 30 minutes after "I paid"', async () => {
    await createAdmin(ctx);
    await enableTransfers(false);
    const battle = await openBattle(ctx);
    await createEntry(ctx, await createUser(ctx));
    await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, duel.photoAId);
    await ctx.services.payments.claimTransfer(order.payment.id, buyer);
    await ctx.prisma.payment.update({ where: { id: order.payment.id }, data: { claimedAt: new Date(Date.now() - 31 * 60_000) } });
    await ctx.prisma.duel.update({ where: { id: duel.id }, data: { endsAt: new Date(Date.now() - 1000), votesA: 1 } });
    await ctx.services.battles.tick();
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('FINISHED');
  });

  it('accepts a transfer with the code that is bigger than the pack price', async () => {
    await enableTransfers(true);
    const [pack] = await ctx.services.payments.listPackages(true);
    const order = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    bank.items = [{ id: 'overpaid', time: 1, amount: order.payment.amount + 1000, currencyCode: 980, description: 'Від: Олег', comment: order.payment.code! }];
    expect(await ctx.services.payments.pollBank()).toBe(1);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: order.payment.id } })).status).toBe('PAID');
  });

  it('never uses one bank transaction twice and respects the Monobank rate limit', async () => {
    await enableTransfers(true);
    const [pack] = await ctx.services.payments.listPackages(true);
    const first = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    bank.items = [{ id: 'tx-1', time: 1, amount: first.payment.amount, currencyCode: 980, description: '', comment: first.payment.code! }];
    expect(await ctx.services.payments.pollBank(new Date())).toBe(1);

    // A second order with the same amount; the old transaction must not pay for it.
    const second = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    bank.items = [{ id: 'tx-1', time: 1, amount: second.payment.amount, currencyCode: 980, description: '', comment: `${first.payment.code} ${second.payment.code}` }];
    const callsBefore = bank.statementCalls;
    expect(await ctx.services.payments.pollBank(new Date())).toBe(0); // within 60 s: skipped
    expect(bank.statementCalls).toBe(callsBefore);
    expect(await ctx.services.payments.pollBank(new Date(Date.now() + 61_000))).toBe(0);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: second.payment.id } })).status).toBe('PENDING');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).voteBalance).toBe(10);
  });

  it('expires unpaid orders, escalates unmatched claims to admins and cancels unanswered ones', async () => {
    await createAdmin(ctx);
    await enableTransfers(true);
    const [pack] = await ctx.services.payments.listPackages(true);
    const unpaid = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    const claimed = await ctx.services.payments.createTransfer(buyer, pack!.id, null);
    await ctx.services.payments.claimTransfer(claimed.payment.id, buyer);

    // Even with the bank check, the admins are asked right away — and only once.
    expect(adminTexts().filter((t) => t.includes(claimed.payment.code!) && t.includes('Проверь перевод'))).toHaveLength(1);
    await ctx.prisma.payment.update({ where: { id: claimed.payment.id }, data: { claimedAt: new Date(Date.now() - 6 * 60_000) } });
    await ctx.services.payments.expireTransfers();
    expect(adminTexts().filter((t) => t.includes(claimed.payment.code!) && t.includes('Проверь перевод'))).toHaveLength(1);

    const in31min = new Date(Date.now() + 31 * 60_000);
    await ctx.services.payments.expireTransfers(in31min);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: unpaid.payment.id } })).status).toBe('CANCELLED');
    expect(dmTo(buyer).some((t) => t.includes('Время на оплату'))).toBe(true);
    expect(adminTexts().some((t) => t.includes(claimed.payment.code!))).toBe(true);

    await ctx.services.payments.expireTransfers(new Date(Date.now() + 13 * 60 * 60_000));
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: claimed.payment.id } })).status).toBe('CANCELLED');
    expect(dmTo(buyer).some((t) => t.includes('не подтверждён'))).toBe(true);
  });
});
