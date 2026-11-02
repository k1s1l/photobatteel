import { beforeEach, describe, expect, it } from 'vitest';
import { createAdmin, createQueuedPhoto, createTestContext, createUser, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  await ctx.services.settings.update({ maxQueuedPerUser: 0, maxPhotosPerDay: 0 }, null);
});

async function publishAll() {
  for (;;) {
    const item = await ctx.services.publications.claimNext();
    if (!item) return;
    await ctx.services.publications.processItem(item.id);
  }
}

describe('voting', () => {
  it('toggles a vote and keeps counters consistent', async () => {
    const owner = await createUser(ctx);
    const voter = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, owner);
    await publishAll();

    expect(await ctx.services.votes.toggle(photo.id, voter)).toEqual({ voted: true, votes: 1 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).votesReceived).toBe(1);
    expect(await ctx.services.votes.toggle(photo.id, voter)).toEqual({ voted: false, votes: 0 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).votesReceived).toBe(0);
    expect(ctx.scheduler.voteRefreshes).toEqual([photo.id, photo.id]);
  });

  it('forbids self-votes, votes for unpublished photos and votes when disabled', async () => {
    const owner = await createUser(ctx);
    const voter = await createUser(ctx);
    const queued = await createQueuedPhoto(ctx, owner);
    await expect(ctx.services.votes.toggle(queued.id, voter)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await publishAll();
    await expect(ctx.services.votes.toggle(queued.id, owner)).rejects.toMatchObject({ code: 'SELF_VOTE' });
    await ctx.services.settings.update({ votingEnabled: false }, null);
    await expect(ctx.services.votes.toggle(queued.id, voter)).rejects.toMatchObject({ code: 'VOTING_DISABLED' });
  });

  it('updates the counter on the channel button', async () => {
    const owner = await createUser(ctx);
    const voter = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, owner);
    await publishAll();
    await ctx.services.votes.toggle(photo.id, voter);
    await ctx.services.votes.refreshButton(photo.id);
    const edit = ctx.telegram.callsOf('editMessageReplyMarkup')[0];
    expect(JSON.stringify(edit?.args[1])).toContain('Поддержать · 1');
  });
});

describe('battles', () => {
  it('runs a full battle lifecycle and picks the winner by votes', async () => {
    const admin = await createAdmin(ctx);
    const battle = await ctx.services.battles.create({ title: 'Осень', theme: 'Листопад', submissionHours: 24, votingHours: 24, createdById: admin.id });
    expect(ctx.telegram.callsOf('sendMessage').some((c) => String(c.args[0]).includes('НОВЫЙ ФОТОБАТЛ'))).toBe(true);
    await expect(
      ctx.services.battles.create({ title: 'Second', theme: null, submissionHours: 1, votingHours: 1, createdById: admin.id }),
    ).rejects.toMatchObject({ code: 'BATTLE_EXISTS' });

    const alice = await createUser(ctx);
    const bob = await createUser(ctx);
    const voters = await Promise.all([1, 2, 3].map(() => createUser(ctx)));
    const photoA = await createQueuedPhoto(ctx, alice);
    const photoB = await createQueuedPhoto(ctx, bob);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photoA.id } })).battleId).toBe(battle.id);
    // One photo per battle by default.
    await expect(createQueuedPhoto(ctx, alice)).rejects.toMatchObject({ code: 'BATTLE_LIMIT' });
    await publishAll();
    for (const voter of voters) await ctx.services.votes.toggle(photoB.id, voter);
    await ctx.services.votes.toggle(photoA.id, voters[0]!);

    await ctx.services.battles.tick(new Date(Date.now() + 25 * 3600_000));
    expect((await ctx.services.battles.findById(battle.id))?.status).toBe('VOTING');
    await ctx.services.battles.tick(new Date(Date.now() + 49 * 3600_000));
    const finished = await ctx.services.battles.findById(battle.id);
    expect(finished?.status).toBe('FINISHED');
    expect(finished?.winnerPhotoId).toBe(photoB.id);
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === Number(bob.telegramId) && String(c.args[0]).includes('победило'))).toBe(true);
  });

  it('closes submissions when only battle submissions are allowed', async () => {
    await ctx.services.settings.update({ submissionsOnlyInBattle: true }, null);
    const user = await createUser(ctx);
    await expect(ctx.services.photos.assertCanSubmit(user)).rejects.toMatchObject({ code: 'NO_ACTIVE_BATTLE' });
    const admin = await createAdmin(ctx);
    const battle = await ctx.services.battles.create({ title: 'B', theme: null, submissionHours: 1, votingHours: 1, createdById: admin.id });
    expect((await ctx.services.photos.assertCanSubmit(user))?.id).toBe(battle.id);
    await ctx.services.battles.closeSubmissions(battle.id, admin.id);
    await expect(ctx.services.photos.assertCanSubmit(user)).rejects.toMatchObject({ code: 'NO_ACTIVE_BATTLE' });
  });

  it('creates weekly battles only when enabled', async () => {
    expect(await ctx.services.battles.createWeeklyIfEnabled()).toBeNull();
    await ctx.services.settings.update({ weeklyBattlesEnabled: true }, null);
    const weekly = await ctx.services.battles.createWeeklyIfEnabled();
    expect(weekly).toMatchObject({ isWeekly: true, title: 'Еженедельный фотобатл #1' });
    expect(await ctx.services.battles.createWeeklyIfEnabled()).toBeNull();
  });
});

describe('statistics and broadcasts', () => {
  it('computes admin statistics', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    await createQueuedPhoto(ctx, user);
    const second = await createQueuedPhoto(ctx, user);
    await ctx.services.photos.reject(second.id, admin.id, 'x');
    const item = await ctx.services.publications.claimNext();
    await ctx.services.publications.processItem(item!.id);
    await createQueuedPhoto(ctx, user);

    const stats = await ctx.services.stats.botStats();
    expect(stats).toMatchObject({ users: 2, received: 3, published: 1, waiting: 1, rejected: 1, published24h: 1 });
    const userStats = await ctx.services.users.getStats(user.id);
    expect(userStats).toMatchObject({ queued: 1 });
    expect(userStats.user).toMatchObject({ photosSubmitted: 3, photosPublished: 1 });
  });

  it('broadcasts to all active users and marks users who blocked the bot', async () => {
    const admin = await createAdmin(ctx);
    const users = await Promise.all([1, 2, 3].map(() => createUser(ctx)));
    const blocked = await createUser(ctx);
    await ctx.services.users.block(blocked.id, admin.id, 'spam');
    const { telegramError } = await import('../helpers/fakes.js');
    ctx.telegram.failNext('copyMessage', telegramError(429, 'Too Many Requests', 1), telegramError(403, 'Forbidden: bot was blocked by the user'));

    const { broadcast, recipients } = await ctx.services.broadcasts.create(admin.id, Number(admin.telegramId), 77);
    expect(recipients).toBe(4); // admin + 3 users, blocked excluded
    const done = await ctx.services.broadcasts.process(broadcast.id, async () => undefined);
    expect(done).toMatchObject({ status: 'DONE', sentCount: 3, failedCount: 1 });
    expect(await ctx.prisma.user.count({ where: { botBlockedAt: { not: null } } })).toBe(1);
    expect(ctx.telegram.callsOf('copyMessage').every((c) => c.chatId !== Number(blocked.telegramId))).toBe(true);
    expect(users).toHaveLength(3);
  });
});
