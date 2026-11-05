import { beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL, createAdmin, createEntry, createTestContext, createUser, expireDuels, openBattle, postPendingDuels, startBattle, type TestContext } from '../helpers/context.js';
import { telegramError } from '../helpers/fakes.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

async function entries(count: number, mediaType: 'PHOTO' | 'VIDEO' = 'PHOTO') {
  const result = [];
  for (let i = 0; i < count; i += 1) result.push(await createEntry(ctx, await createUser(ctx), mediaType));
  return result;
}

async function setVotes(duelId: number, votesA: number, votesB: number) {
  await ctx.prisma.duel.update({ where: { id: duelId }, data: { votesA, votesB } });
}

describe('scheduling', () => {
  it('announces the battle in the channel and allows only one at a time', async () => {
    const battle = await openBattle(ctx);
    expect(battle.status).toBe('SCHEDULED');
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === CHANNEL.id && String(c.args[0]).includes('НОВЫЙ ФОТОБАТЛ'))).toBe(true);
    expect(ctx.scheduler.timedTicks).toEqual([{ at: battle.startsAt, key: `battle-${battle.id}` }]);
    await expect(openBattle(ctx)).rejects.toMatchObject({ code: 'BATTLE_EXISTS' });
    await expect(
      ctx.services.battles.schedule({ title: 'x', startsAt: new Date(Date.now() - 1000), roundMinutes: 60, tiebreakMinutes: 10, createdById: null }),
    ).rejects.toThrow(RangeError);
  });

  it('does not start before the scheduled time', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await ctx.services.battles.tick();
    expect((await ctx.services.battles.findById(battle.id))?.status).toBe('SCHEDULED');
    expect(await ctx.prisma.duel.count()).toBe(0);
  });
});

describe('start and pairing', () => {
  it('pairs all entries at the start time and posts each pair as one collage with buttons', async () => {
    const battle = await openBattle(ctx);
    const [a, b, c, d] = await entries(4);
    await startBattle(ctx, battle.id);

    expect((await ctx.services.battles.findById(battle.id))).toMatchObject({ status: 'RUNNING', currentRound: 1 });
    const duels = await ctx.prisma.duel.findMany({ orderBy: { position: 'asc' } });
    expect(duels).toHaveLength(2);
    expect(new Set(duels.flatMap((duel) => [duel.photoAId, duel.photoBId]))).toEqual(new Set([a!.id, b!.id, c!.id, d!.id]));
    expect(ctx.scheduler.duelPosts.map((job) => job.duelId).sort()).toEqual(duels.map((duel) => duel.id).sort());
    expect(await ctx.prisma.photo.count({ where: { status: 'IN_BATTLE' } })).toBe(4);

    await postPendingDuels(ctx);
    const posts = ctx.telegram.callsOf('sendPhoto').filter((call) => call.chatId === CHANNEL.id);
    expect(posts).toHaveLength(2);
    const [image, options] = posts[0]!.args as [Buffer, { caption: string; replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
    expect(Buffer.isBuffer(image)).toBe(true); // the collage, not a single file id
    expect(options.caption).toContain('Раунд 1 · Пара 1');
    expect(options.caption).not.toMatch(/@user/); // authors are never shown
    expect(options.replyMarkup.inline_keyboard[0]?.map((button) => button.text)).toEqual(['Поддержать 1 · 0', 'Поддержать 2 · 0']);

    const active = await ctx.prisma.duel.findFirstOrThrow({ where: { position: 1 } });
    expect(active.status).toBe('ACTIVE');
    expect(active.endsAt!.getTime() - active.postedAt!.getTime()).toBe(60 * 60_000);
    // A precise tick is scheduled for the end of the vote.
    expect(ctx.scheduler.timedTicks).toContainEqual({ at: active.endsAt, key: `duel-${active.id}-0` });
    // Authors are told their entry is live.
    expect(ctx.telegram.callsOf('sendMessage').filter((c) => String(c.args[0]).includes('вышла в канал'))).toHaveLength(4);
  });

  it('gives a bye to the odd entry and posts videos as an album with a buttons message', async () => {
    const battle = await openBattle(ctx);
    await entries(3, 'VIDEO');
    await startBattle(ctx, battle.id);
    const bye = await ctx.prisma.duel.findFirstOrThrow({ where: { photoBId: null } });
    expect(bye).toMatchObject({ status: 'FINISHED', winnerPhotoId: bye.photoAId });

    await postPendingDuels(ctx);
    const album = ctx.telegram.callsOf('sendMediaGroup')[0]!;
    expect((album.args[0] as { type: string }[]).map((item) => item.type)).toEqual(['video', 'video']);
    const buttons = ctx.telegram.callsOf('sendMessage').find((c) => c.chatId === CHANNEL.id && String(c.args[0]).includes('Пара 1'))!;
    expect((buttons.args[1] as { replyToMessageId: number }).replyToMessageId).toBeGreaterThan(0);
    expect((await ctx.prisma.duel.findFirstOrThrow({ where: { status: 'ACTIVE' } })).mediaMessageIds).toHaveLength(2);
  });

  it('cancels a battle without entries and crowns a single entry', async () => {
    const empty = await openBattle(ctx);
    await startBattle(ctx, empty.id);
    expect((await ctx.services.battles.findById(empty.id))?.status).toBe('CANCELLED');

    const solo = await openBattle(ctx);
    const [only] = await entries(1);
    await startBattle(ctx, solo.id);
    expect(await ctx.services.battles.findById(solo.id)).toMatchObject({ status: 'FINISHED', winnerPhotoId: only!.id });
  });
});

describe('results', () => {
  it('advances the entry with more votes, eliminates the other and closes the buttons', async () => {
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const [first, second] = await ctx.prisma.duel.findMany({ orderBy: { position: 'asc' } });
    await setVotes(first!.id, 5, 2);
    await setVotes(second!.id, 1, 3);
    await expireDuels(ctx);

    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ status: 'FINISHED', winnerPhotoId: first!.photoAId });
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first!.photoBId! } })).status).toBe('ELIMINATED');
    const closed = ctx.telegram.callsOf('editMessageReplyMarkup').find((c) => c.args[0] === first!.messageId)!;
    expect(JSON.stringify(closed.args[1])).toContain('🏆 Поддержать 1 · 5');
    // Round 2 is created from the winners right away.
    const round2 = await ctx.prisma.duel.findMany({ where: { round: 2 } });
    expect(round2).toHaveLength(1);
    expect([round2[0]!.photoAId, round2[0]!.photoBId]).toEqual([first!.photoAId, second!.photoBId]);
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === CHANNEL.id && String(c.args[0]).includes('раунд 2'))).toBe(true);
  });

  it('reposts a tie for a short revote with votes reset, then the earlier entry wins', async () => {
    const battle = await openBattle(ctx, { tiebreakMinutes: 10 });
    const [early] = await entries(2);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await setVotes(duel.id, 4, 4);
    await expireDuels(ctx);

    const tiebreak = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(tiebreak).toMatchObject({ status: 'PENDING', stage: 1, votesA: 0, votesB: 0 });
    expect(JSON.stringify(ctx.telegram.callsOf('editMessageReplyMarkup').at(-1)?.args[1])).toContain('Ничья');
    expect(ctx.scheduler.duelPosts.at(-1)).toEqual({ duelId: duel.id, stage: 1 });

    await postPendingDuels(ctx);
    const reposted = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(reposted.endsAt!.getTime() - reposted.postedAt!.getTime()).toBe(10 * 60_000);
    const lastCaption = (ctx.telegram.callsOf('sendPhoto').at(-1)!.args[1] as { caption: string }).caption;
    expect(lastCaption).toContain('Переголосование');

    // MAX_TIEBREAKS = 2 in tests: two more ties, then the earlier entry advances.
    await expireDuels(ctx);
    await postPendingDuels(ctx);
    await expireDuels(ctx);
    const final = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(final).toMatchObject({ status: 'FINISHED', stage: 2 });
    const winner = [duel.photoAId, duel.photoBId].includes(early!.id) ? early!.id : null;
    expect(final.winnerPhotoId).toBe(winner);
  });

  it('plays rounds until a single winner and announces it without the author name', async () => {
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    for (let round = 1; round <= 2; round += 1) {
      await postPendingDuels(ctx);
      const active = await ctx.prisma.duel.findMany({ where: { status: 'ACTIVE' } });
      for (const duel of active) await setVotes(duel.id, 3, 1);
      await expireDuels(ctx);
    }
    const finished = await ctx.services.battles.findById(battle.id);
    expect(finished?.status).toBe('FINISHED');
    const winner = await ctx.prisma.photo.findUniqueOrThrow({ where: { id: finished!.winnerPhotoId! }, include: { user: true } });
    expect(winner.status).toBe('WINNER');
    const announcement = ctx.telegram.callsOf('sendPhoto').find((c) => String((c.args[1] as { caption?: string })?.caption).includes('Победитель батла'))!;
    expect(announcement.args[0]).toBe(winner.fileId);
    expect(String((announcement.args[1] as { caption: string }).caption)).not.toContain(winner.user.username!);
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === Number(winner.user.telegramId) && String(c.args[0]).includes('победила'))).toBe(true);
  });
});

describe('design template and posting errors', () => {
  it('posts with the admin design, falling back to regular emoji when premium emoji are rejected', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.settings.update({ duelTemplate: '<tg-emoji emoji-id="111">🔥</tg-emoji> <b>{battle}</b> {stage}' }, admin.id);
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    ctx.telegram.failNext('sendPhoto', telegramError(400, 'Bad Request: CUSTOM_EMOJI_NOT_ALLOWED in entities'));
    await postPendingDuels(ctx);

    const [rejected, accepted] = ctx.telegram.callsOf('sendPhoto').map((c) => (c.args[1] as { caption: string }).caption);
    expect(rejected).toContain('<tg-emoji emoji-id="111">');
    expect(accepted).toBe('🔥 <b>Осень</b> Раунд 1 · Пара 1');
    expect((await ctx.prisma.duel.findFirstOrThrow()).status).toBe('ACTIVE');
  });

  it('keeps the duel pending and alerts admins on permanent posting errors', async () => {
    await createAdmin(ctx);
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    ctx.telegram.failNext('sendPhoto', telegramError(403, 'Forbidden: bot is not a member of the channel chat'));
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await expect(ctx.services.battles.postDuel(duel.id, 0)).rejects.toThrow();
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('PENDING');
    expect(ctx.telegram.callsOf('sendMessage').some((c) => String(c.args[0]).includes('Не удаётся опубликовать пару'))).toBe(true);
  });

  it('never posts the same duel stage twice', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    expect(await ctx.services.battles.postDuel(duel.id, 0)).toBe('posted');
    expect(await ctx.services.battles.postDuel(duel.id, 0)).toBe('skipped');
    expect(ctx.telegram.callsOf('sendPhoto')).toHaveLength(1);
  });

  it('cancels a running battle and closes open duels', async () => {
    const admin = await createAdmin(ctx);
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    await ctx.services.battles.cancel(battle.id, admin.id);
    expect((await ctx.services.battles.findById(battle.id))?.status).toBe('CANCELLED');
    expect(await ctx.prisma.duel.count({ where: { status: { not: 'FINISHED' } } })).toBe(0);
    expect(await ctx.prisma.photo.count({ where: { status: 'IN_BATTLE' } })).toBe(0);
  });
});
