import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/generated/prisma/client.js';
import type { DraftInput } from '../../src/modules/photos/photo.service.js';
import { createAdmin, createEntry, createTestContext, createUser, expireDuels, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  await createAdmin(ctx);
});

/** Buys a place for the user the way Telegram does it: invoice → checkout → successful payment. */
async function buy(user: User, charge = `charge-${user.id}`) {
  const invoice = await ctx.services.finalSpots.createInvoice(user);
  expect(await ctx.services.finalSpots.validateCheckout({ payload: invoice.payload, telegramUserId: Number(user.telegramId), currency: 'XTR', totalAmount: invoice.amount })).toBeNull();
  return ctx.services.finalSpots.completePayment({ payload: invoice.payload, telegramUserId: Number(user.telegramId), telegramChargeId: charge });
}

function media(fileUniqueId: string): DraftInput {
  return { mediaType: 'PHOTO', source: 'PHOTO', fileId: `file-${fileUniqueId}`, fileUniqueId, contentHash: `hash-${fileUniqueId}`, mimeType: 'image/jpeg', width: 800, height: 800, fileSize: 1000 };
}

/** A running battle of 6 entries, played until round 2 (3 entries left: a pair and a bye). */
async function battleInRound2() {
  const battle = await openBattle(ctx);
  const entries = [];
  for (let i = 0; i < 6; i += 1) {
    const user = await createUser(ctx);
    entries.push({ user, photo: await createEntry(ctx, user) });
  }
  await startBattle(ctx, battle.id);
  await postPendingDuels(ctx);
  for (const duel of await ctx.prisma.duel.findMany({ where: { status: 'ACTIVE' } })) await ctx.prisma.duel.update({ where: { id: duel.id }, data: { votesA: 1 } });
  await expireDuels(ctx);
  return { battle, entries };
}

async function consenting(): Promise<User> {
  const user = await createUser(ctx);
  return ctx.prisma.user.update({ where: { id: user.id }, data: { consentAt: new Date() } });
}

describe('places in the final', () => {
  it('opens the sale in round 2 (round 3 for battles over 24 entries) and not for entries still playing', async () => {
    const battle = await openBattle(ctx);
    for (let i = 0; i < 6; i += 1) await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    expect(await ctx.services.finalSpots.offer(null)).toMatchObject({ available: false, reason: 'TOO_EARLY', fromRound: 2 });

    // Big battles open one round later.
    await ctx.prisma.battle.update({ where: { id: battle.id }, data: { status: 'FINISHED' } });
    const big = await ctx.prisma.battle.create({ data: { title: 'Big', startsAt: new Date(), roundMinutes: 30, status: 'RUNNING', currentRound: 2 } });
    const users = await Promise.all(Array.from({ length: 13 }, () => createUser(ctx)));
    for (const [i, user] of users.entries()) {
      const photo = await ctx.prisma.photo.create({ data: { ...media(`big-${i}`), userId: user.id, battleId: big.id, status: 'IN_BATTLE' } });
      const other = await ctx.prisma.photo.create({ data: { ...media(`big-b-${i}`), userId: user.id, battleId: big.id, status: 'ELIMINATED' } });
      await ctx.prisma.duel.create({ data: { battleId: big.id, round: 1, position: i + 1, photoAId: photo.id, photoBId: other.id, status: 'FINISHED' } });
    }
    for (let i = 0; i < 6; i += 1) {
      await ctx.prisma.duel.create({ data: { battleId: big.id, round: 2, position: i + 1, photoAId: (await ctx.prisma.photo.findFirstOrThrow({ where: { fileUniqueId: `big-${2 * i}` } })).id, photoBId: (await ctx.prisma.photo.findFirstOrThrow({ where: { fileUniqueId: `big-${2 * i + 1}` } })).id } });
    }
    expect(await ctx.services.finalSpots.offer(null)).toMatchObject({ available: false, reason: 'TOO_EARLY', fromRound: 3 });
  });

  it('sells at most 2 places, refunds a buyer who lost the race for the last one', async () => {
    await battleInRound2();
    const stillIn = await ctx.prisma.photo.findFirstOrThrow({ where: { status: 'IN_BATTLE' }, include: { user: true } });
    await expect(ctx.services.finalSpots.createInvoice(stillIn.user)).rejects.toMatchObject({ code: 'FINAL_SPOT_UNAVAILABLE', params: { reason: 'STILL_PLAYING' } });

    const outsider = await consenting();
    expect(await buy(outsider)).toMatchObject({ kind: 'reserved' });
    await expect(ctx.services.finalSpots.createInvoice(outsider)).rejects.toMatchObject({ params: { reason: 'ALREADY_BOUGHT' } });

    // Two people open an invoice for the last place; the one who pays second gets the Stars back.
    const a = await consenting();
    const b = await consenting();
    const invoiceA = await ctx.services.finalSpots.createInvoice(a);
    const invoiceB = await ctx.services.finalSpots.createInvoice(b);
    expect(await ctx.services.finalSpots.completePayment({ payload: invoiceA.payload, telegramUserId: Number(a.telegramId), telegramChargeId: 'ch-a' })).toMatchObject({ kind: 'reserved' });
    expect(await ctx.services.finalSpots.completePayment({ payload: invoiceB.payload, telegramUserId: Number(b.telegramId), telegramChargeId: 'ch-b' })).toMatchObject({ kind: 'refunded', reason: 'SOLD_OUT' });
    expect(ctx.telegram.callsOf('refundStarPayment').map((c) => c.args[0])).toEqual(['ch-b']);
    expect(await ctx.services.finalSpots.offer(null)).toMatchObject({ available: false, reason: 'SOLD_OUT' });
    // Admins learn who bought (never shown in the channel).
    expect(ctx.telegram.callsOf('sendMessage').some((c) => String(c.args[0]).includes('Куплено место в финале'))).toBe(true);
  });

  it('lets an eliminated author send the same photo again; puts paid places into the final and refunds places without a photo', async () => {
    const { battle, entries } = await battleInRound2();
    const eliminated = await ctx.prisma.photo.findFirstOrThrow({ where: { status: 'ELIMINATED' }, include: { user: true } });
    const loser = await ctx.prisma.user.update({ where: { id: eliminated.userId }, data: { consentAt: new Date() } });
    expect(await buy(loser)).toMatchObject({ kind: 'reserved' });
    // Their own old photo is fine; somebody else's is not.
    const foreign = entries.find((e) => e.user.id !== loser.id)!.photo;
    await expect(ctx.services.finalSpots.attachPhoto(loser, media(foreign.fileUniqueId))).rejects.toMatchObject({ code: 'DUPLICATE_PHOTO' });
    const spot = await ctx.services.finalSpots.attachPhoto(loser, { ...media(eliminated.fileUniqueId), contentHash: eliminated.contentHash });
    expect(spot.photoId).not.toBeNull();

    const silent = await consenting();
    expect(await buy(silent, 'ch-silent')).toMatchObject({ kind: 'reserved' });

    // Round 2 (a pair and a bye) ends: the final has the 2 finalists and the paid place.
    await postPendingDuels(ctx);
    await ctx.prisma.duel.updateMany({ where: { status: 'ACTIVE' }, data: { votesA: 1 } });
    await expireDuels(ctx);
    const final = await ctx.prisma.duel.findFirstOrThrow({ where: { round: 3 } });
    const players = [final.photoAId, final.photoBId, final.photoCId, final.photoDId].filter((id) => id !== null);
    expect(players).toHaveLength(3);
    expect(players).toContain(spot.photoId);
    expect((await ctx.prisma.battle.findUniqueOrThrow({ where: { id: battle.id } })).finalSize).toBe(3);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: spot.photoId! } })).status).toBe('IN_BATTLE');

    // The place without a photo is refunded; nothing more is on sale.
    expect(ctx.telegram.callsOf('refundStarPayment').map((c) => c.args[0])).toEqual(['ch-silent']);
    expect(await ctx.prisma.finalSpot.findFirstOrThrow({ where: { userId: silent.id } })).toMatchObject({ refundedAt: expect.any(Date) });
    expect(await ctx.services.finalSpots.offer(null)).toMatchObject({ available: false, reason: 'FINAL_STARTED' });
  });

  it('refunds unused places when the battle is cancelled and keeps the final within 4 entries', async () => {
    const { battle } = await battleInRound2();
    const buyer = await consenting();
    await buy(buyer, 'ch-cancel');
    await expect(ctx.services.battles.setFinalSize(battle.id, 4, null)).rejects.toMatchObject({ code: 'FINAL_SPOTS_TAKEN' });
    const admin = await ctx.prisma.user.findFirstOrThrow({ where: { admin: { isNot: null } } });
    await ctx.services.battles.cancel(battle.id, admin.id);
    expect(ctx.telegram.callsOf('refundStarPayment').map((c) => c.args[0])).toEqual(['ch-cancel']);
  });
});
