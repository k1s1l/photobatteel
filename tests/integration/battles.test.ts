import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_TG_ID,
  CHANNEL,
  createAdmin,
  createEntry,
  createTestContext,
  createUser,
  expireDuels,
  openBattle,
  postPendingDuels,
  preparePendingDuels,
  publishReadyDuels,
  startBattle,
  type TestContext,
} from '../helpers/context.js';
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

const toChannel = (method: string) => ctx.telegram.callsOf(method).filter((c) => c.chatId === CHANNEL.id);
const toAdmin = (method: string) => ctx.telegram.callsOf(method).filter((c) => c.chatId === ADMIN_TG_ID);
const adminTexts = () => toAdmin('sendMessage').map((c) => String(c.args[0]));

describe('scheduling', () => {
  it('prepares the announcement for the admins (the bot posts nothing to the channel) and allows one battle at a time', async () => {
    const battle = await openBattle(ctx);
    expect(battle.status).toBe('SCHEDULED');
    expect(adminTexts().some((t) => t.includes('НОВЫЙ ФОТОБАТЛ'))).toBe(true);
    expect(adminTexts().some((t) => t.includes('Пост для канала'))).toBe(true);
    expect(ctx.telegram.calls.filter((c) => c.chatId === CHANNEL.id)).toHaveLength(0);
    expect(ctx.scheduler.timedTicks).toEqual([{ at: battle.startsAt, key: `battle-${battle.id}` }]);
    await expect(openBattle(ctx)).rejects.toMatchObject({ code: 'BATTLE_EXISTS' });
  });

  it('does not start before the scheduled time', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await ctx.services.battles.tick();
    expect((await ctx.services.battles.findById(battle.id))?.status).toBe('SCHEDULED');
    expect(await ctx.prisma.duel.count()).toBe(0);
  });
});

describe('start, prepared posts and publication by the admin', () => {
  it('pairs entries at the start and sends each pair to the admin as a ready collage post', async () => {
    const battle = await openBattle(ctx);
    const all = await entries(4);
    await startBattle(ctx, battle.id);
    expect(await ctx.services.battles.findById(battle.id)).toMatchObject({ status: 'RUNNING', currentRound: 1 });
    const duels = await ctx.prisma.duel.findMany({ orderBy: { position: 'asc' } });
    expect(duels).toHaveLength(2);
    expect(new Set(duels.flatMap((duel) => [duel.photoAId, duel.photoBId]))).toEqual(new Set(all.map((p) => p.id)));

    await preparePendingDuels(ctx);
    const prepared = toAdmin('sendPhoto');
    expect(prepared).toHaveLength(2);
    const [image, options] = prepared[0]!.args as [Buffer, { caption: string; replyMarkup?: unknown }];
    expect(Buffer.isBuffer(image)).toBe(true); // the collage
    expect(options.caption).toContain('Полуфинал · Пара 1'); // 4 entries: the first round is a semifinal
    expect(options.replyMarkup).toBeUndefined(); // the forwarded post must stay clean
    expect(adminTexts().some((t) => t.includes('Перешли пост ниже в канал'))).toBe(true);
    expect(toChannel('sendPhoto')).toHaveLength(0);
    const ready = await ctx.prisma.duel.findFirstOrThrow({ where: { position: 1 } });
    expect(ready.status).toBe('READY');
    expect(ready.preparedFileUniqueId).toBeTruthy();
  });

  it('goes live when the admin forwards the post: buttons under it, timer, notifications', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    const [postId] = await publishReadyDuels(ctx);

    const duel = await ctx.prisma.duel.findFirstOrThrow();
    expect(duel.status).toBe('ACTIVE');
    expect(duel.mediaMessageIds).toEqual([postId]);
    expect(duel.endsAt!.getTime() - duel.postedAt!.getTime()).toBe(60 * 60_000);
    expect(ctx.scheduler.timedTicks).toContainEqual({ at: duel.endsAt, key: `duel-${duel.id}-0` });

    const buttons = toChannel('sendMessage')[0]!;
    expect(String(buttons.args[0])).toBe('🗳 Финал — голосуй 👇');
    const options = buttons.args[1] as { replyToMessageId: number; replyMarkup: { inline_keyboard: { text: string }[][] } };
    expect(options.replyToMessageId).toBe(postId);
    expect(options.replyMarkup.inline_keyboard[0]?.map((b) => b.text)).toEqual(['Поддержать 1 · 0', 'Поддержать 2 · 0']);
    expect(duel.messageId).toBeGreaterThan(0);
    expect(adminTexts().some((t) => t.includes('✅ Финал — опубликовано'))).toBe(true);
    expect(ctx.telegram.callsOf('sendMessage').filter((c) => String(c.args[0]).includes('вышла в канал'))).toHaveLength(2);
  });

  it('ignores unrelated channel posts and a second copy of the same post', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    expect(await ctx.services.battles.linkChannelPost({ messageId: 1, fileUniqueIds: ['something-else'] })).toBe(false);
    expect(await ctx.services.battles.linkChannelPost({ messageId: 2, fileUniqueIds: [] })).toBe(false);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await ctx.services.battles.linkChannelPost({ messageId: 3, fileUniqueIds: [duel.preparedFileUniqueId!] });
    await ctx.services.battles.linkChannelPost({ messageId: 4, fileUniqueIds: [duel.preparedFileUniqueId!] });
    expect(toChannel('sendMessage')).toHaveLength(1);
  });

  it('lets the entry submitted last pass without a vote when the number is odd', async () => {
    const battle = await openBattle(ctx);
    const created = await entries(5);
    // The second entry was confirmed last, although it was uploaded early.
    await ctx.prisma.photo.update({ where: { id: created[1]!.id }, data: { confirmedAt: new Date(Date.now() + 60_000) } });
    await startBattle(ctx, battle.id);
    const bye = await ctx.prisma.duel.findFirstOrThrow({ where: { round: 1, photoBId: null } });
    expect(bye.photoAId).toBe(created[1]!.id);

    // Round 2 has 3 entries: again the latest of them passes.
    for (const duel of await ctx.prisma.duel.findMany({ where: { round: 1, photoBId: { not: null } } })) {
      await ctx.prisma.duel.update({ where: { id: duel.id }, data: { status: 'ACTIVE', endsAt: new Date(Date.now() - 1000), votesA: 1 } });
    }
    await expireDuels(ctx);
    const round2 = await ctx.prisma.duel.findMany({ where: { round: 2 }, include: { photoA: true } });
    const players = await ctx.prisma.photo.findMany({ where: { id: { in: round2.flatMap((d) => [d.photoAId, d.photoBId ?? 0]) } } });
    const latest = players.reduce((a, b) => ((b.confirmedAt ?? b.createdAt) > (a.confirmedAt ?? a.createdAt) ? b : a));
    expect(round2.find((d) => d.photoBId === null)!.photoAId).toBe(latest.id);
  });

  it('republishes a wrongly posted pair: removes it from the channel and prepares it again, keeping votes', async () => {
    const admin = await createAdmin(ctx);
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const before = await ctx.prisma.duel.findFirstOrThrow({ where: { position: 2 } });
    await setVotes(before.id, 3, 1);
    expect(await ctx.services.battles.republishable(battle.id, 1)).toHaveLength(2);

    expect(await ctx.services.battles.republish(before.id, admin.id)).toBe(true);
    expect(await ctx.services.battles.republish(before.id, admin.id)).toBe(false);
    const deleted = toChannel('deleteMessage').map((c) => c.args[0]);
    expect(deleted).toEqual(expect.arrayContaining([before.messageId, ...before.mediaMessageIds]));
    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ status: 'PENDING', messageId: null, mediaMessageIds: [], votesA: 3, votesB: 1 });

    await postPendingDuels(ctx);
    const after = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.status).toBe('ACTIVE');
    const keyboard = JSON.stringify(toChannel('sendMessage').at(-1)!.args[1]);
    expect(keyboard).toContain('· 3');
    expect(keyboard).toContain('· 1');
  });

  it('prepares videos as an album with the caption and links every album item', async () => {
    const battle = await openBattle(ctx);
    await entries(3, 'VIDEO');
    await startBattle(ctx, battle.id);
    const bye = await ctx.prisma.duel.findFirstOrThrow({ where: { photoBId: null } });
    expect(bye).toMatchObject({ status: 'FINISHED', winnerPhotoId: bye.photoAId });

    await preparePendingDuels(ctx);
    const album = toAdmin('sendMediaGroup')[0]!.args[0] as { type: string; caption?: string }[];
    expect(album.map((item) => item.type)).toEqual(['video', 'video']);
    expect(album[0]!.caption).toContain('Пара 1');
    const duel = await ctx.prisma.duel.findFirstOrThrow({ where: { status: 'READY' }, include: { photoA: true, photoB: true } });
    // The channel receives the album as two posts.
    await ctx.services.battles.linkChannelPost({ messageId: 501, fileUniqueIds: [duel.photoA.fileUniqueId] });
    await ctx.services.battles.linkChannelPost({ messageId: 502, fileUniqueIds: [duel.photoB!.fileUniqueId] });
    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).toMatchObject({ status: 'ACTIVE', mediaMessageIds: [501, 502] });
    expect(toChannel('sendMessage')).toHaveLength(1);
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
    const round2 = await ctx.prisma.duel.findMany({ where: { round: 2 } });
    expect(round2).toHaveLength(1);
    expect([round2[0]!.photoAId, round2[0]!.photoBId]).toEqual([first!.photoAId, second!.photoBId]);
    expect(adminTexts().some((t) => t.includes('Осень — Финал'))).toBe(true);
  });

  it('prepares a tie for a short revote with votes reset, then the earlier entry wins', async () => {
    const battle = await openBattle(ctx, { tiebreakMinutes: 10 });
    const [early] = await entries(2);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await setVotes(duel.id, 4, 4);
    await expireDuels(ctx);

    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).toMatchObject({ status: 'PENDING', stage: 1, votesA: 0, votesB: 0 });
    expect(JSON.stringify(ctx.telegram.callsOf('editMessageReplyMarkup').at(-1)?.args[1])).toContain('Ничья');
    await preparePendingDuels(ctx);
    expect(adminTexts().at(-1)).toContain('Переголосование');
    expect((toAdmin('sendPhoto').at(-1)!.args[1] as { caption: string }).caption).toContain('Переголосование');
    await publishReadyDuels(ctx);
    const reposted = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(reposted.endsAt!.getTime() - reposted.postedAt!.getTime()).toBe(10 * 60_000);

    // MAX_TIEBREAKS = 2 in tests: another tie, then the earlier entry advances.
    await expireDuels(ctx);
    await postPendingDuels(ctx);
    await expireDuels(ctx);
    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).toMatchObject({ status: 'FINISHED', stage: 2, winnerPhotoId: early!.id });
  });

  it('plays rounds until a single winner and prepares the winner post without the author name', async () => {
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    for (let round = 1; round <= 2; round += 1) {
      await postPendingDuels(ctx);
      for (const duel of await ctx.prisma.duel.findMany({ where: { status: 'ACTIVE' } })) await setVotes(duel.id, 3, 1);
      await expireDuels(ctx);
    }
    const finished = await ctx.services.battles.findById(battle.id);
    expect(finished?.status).toBe('FINISHED');
    const winner = await ctx.prisma.photo.findUniqueOrThrow({ where: { id: finished!.winnerPhotoId! }, include: { user: true } });
    expect(winner.status).toBe('WINNER');
    const post = toAdmin('sendPhoto').find((c) => String((c.args[1] as { caption?: string })?.caption).includes('Победитель батла'))!;
    expect(post.args[0]).toBe(winner.fileId);
    expect(String((post.args[1] as { caption: string }).caption)).not.toContain(winner.user.username!);
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === Number(winner.user.telegramId) && String(c.args[0]).includes('победила'))).toBe(true);
  });
});

describe('design template and errors', () => {
  it('prepares posts with the admin design and falls back to regular emoji when premium emoji are rejected', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.settings.update({ duelTemplate: '<tg-emoji emoji-id="111">🔥</tg-emoji> <b>{battle}</b> {stage}' }, admin.id);
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    expect((toAdmin('sendPhoto')[0]!.args[1] as { caption: string }).caption).toBe('<tg-emoji emoji-id="111">🔥</tg-emoji> <b>Осень</b> Финал');

    await ctx.services.battles.cancel(battle.id, admin.id);
    const second = await openBattle(ctx);
    await ctx.services.settings.update({ maxPhotosPerBattle: 0 }, admin.id);
    await entries(2);
    await startBattle(ctx, second.id);
    ctx.telegram.failNext('sendPhoto', telegramError(400, 'Bad Request: CUSTOM_EMOJI_NOT_ALLOWED in entities'));
    await preparePendingDuels(ctx);
    expect((toAdmin('sendPhoto').at(-1)!.args[1] as { caption: string }).caption).toBe('🔥 <b>Осень</b> Финал');
    expect((await ctx.prisma.duel.findFirstOrThrow({ where: { battleId: second.id } })).status).toBe('READY');
  });

  it('keeps the duel pending and alerts admins on permanent errors', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    ctx.telegram.failNext('downloadFile', telegramError(400, 'Bad Request: file is too big'));
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await expect(ctx.services.battles.prepareDuel(duel.id, 0)).rejects.toThrow();
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('PENDING');
    expect(adminTexts().some((t) => t.includes('Не удаётся подготовить пост пары'))).toBe(true);
  });

  it('never prepares the same duel stage twice', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    expect(await ctx.services.battles.prepareDuel(duel.id, 0)).toBe('prepared');
    expect(await ctx.services.battles.prepareDuel(duel.id, 0)).toBe('skipped');
    expect(toAdmin('sendPhoto')).toHaveLength(1);
  });

  it('cancels a running battle and closes open duels', async () => {
    const admin = await createAdmin(ctx);
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    await ctx.services.battles.cancel(battle.id, admin.id);
    expect((await ctx.services.battles.findById(battle.id))?.status).toBe('CANCELLED');
    expect(await ctx.prisma.duel.count({ where: { status: { not: 'FINISHED' } } })).toBe(0);
    expect(await ctx.prisma.photo.count({ where: { status: 'IN_BATTLE' } })).toBe(0);
  });
});

describe('templates, final duration and reminders', () => {
  it('uses the admin designs for the announcement, round, buttons and winner posts', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.settings.update(
      {
        announceTemplate: '<b>{battle}</b> стартует {start}, бот {bot}',
        roundTemplate: '<i>{roundName}</i>: {entries}',
        buttonsTemplate: '<b>{stage}</b>',
        winnerTemplate: '👑 {battle}: {votes}',
      },
      admin.id,
    );
    const battle = await openBattle(ctx);
    expect(adminTexts().some((t) => /^<b>Осень<\/b> стартует .+, бот @photobattle_bot$/.test(t))).toBe(true);
    await entries(2);
    await startBattle(ctx, battle.id);
    expect(adminTexts()).toContain('<i>Финал</i>: 2');
    await postPendingDuels(ctx);
    expect(String(toChannel('sendMessage')[0]!.args[0])).toBe('<b>Финал</b>');
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    await setVotes(duel.id, 2, 1);
    await expireDuels(ctx);
    expect(toAdmin('sendPhoto').some((c) => (c.args[1] as { caption?: string }).caption === '👑 Осень: 0')).toBe(true);
  });

  it('uses the per-round designs for the stage they were made for', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.settings.update({ buttonsTemplate: '<b>{stage}</b>' }, admin.id);
    await ctx.services.settings.setStageTemplate('buttons', 'final', '<tg-emoji emoji-id="7">Ф</tg-emoji>ИНАЛ', admin.id);
    await ctx.services.settings.setStageTemplate('round', 'final', 'ФИНАЛ! {entries}', admin.id);
    await ctx.services.settings.setStageTemplate('buttons', 'r2', 'never used', admin.id);
    const battle = await openBattle(ctx);
    await entries(4);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    // Round 1 has no own design: the general one is used.
    expect(String(toChannel('sendMessage')[0]!.args[0])).toBe('<b>Полуфинал · Пара 1</b>');
    for (const duel of await ctx.prisma.duel.findMany({ where: { status: 'ACTIVE' } })) await setVotes(duel.id, 1, 0);
    await expireDuels(ctx);
    expect(adminTexts()).toContain('ФИНАЛ! 2');
    await postPendingDuels(ctx);
    // Round 2 is the final here, and the final design wins over the "round 2" one.
    expect(toChannel('sendMessage').map((c) => String(c.args[0]))).toContain('<tg-emoji emoji-id="7">Ф</tg-emoji>ИНАЛ');

    await ctx.services.settings.setStageTemplate('buttons', 'final', null, admin.id);
    expect((await ctx.services.settings.get()).stageTemplates).toEqual({ 'round:final': 'ФИНАЛ! {entries}', 'buttons:r2': 'never used' });
  });

  it('shows the end of voting with {end}', async () => {
    const admin = await createAdmin(ctx);
    await ctx.services.settings.update({ buttonsTemplate: 'до {end}', roundTemplate: '{roundName} до {end}' }, admin.id);
    const battle = await ctx.services.battles.schedule({ title: 'E', startsAt: new Date(Date.now() + 60_000), roundMinutes: 30, finalMinutes: 120, tiebreakMinutes: 10, createdById: null });
    await entries(2);
    await startBattle(ctx, battle.id);
    const time = (date: Date) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    // Two entries: the first round is the final, with the final's own duration.
    expect(adminTexts().some((t) => t === `Финал до ${time(new Date(Date.now() + 120 * 60_000))}` || t === `Финал до ${time(new Date(Date.now() + 119 * 60_000))}`)).toBe(true);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    expect(String(toChannel('sendMessage')[0]!.args[0])).toBe(`до ${time(duel.endsAt!)}`);
  });

  it('gives the final its own voting time', async () => {
    const battle = await ctx.services.battles.schedule({
      title: 'F',
      startsAt: new Date(Date.now() + 60_000),
      roundMinutes: 30,
      finalMinutes: 180,
      tiebreakMinutes: 10,
      createdById: null,
    });
    await entries(4);
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const semi = await ctx.prisma.duel.findFirstOrThrow({ where: { round: 1 } });
    expect(semi.endsAt!.getTime() - semi.postedAt!.getTime()).toBe(30 * 60_000);
    for (const duel of await ctx.prisma.duel.findMany({ where: { status: 'ACTIVE' } })) await setVotes(duel.id, 1, 0);
    await expireDuels(ctx);
    await postPendingDuels(ctx);
    const final = await ctx.prisma.duel.findFirstOrThrow({ where: { round: 2 } });
    expect(final.endsAt!.getTime() - final.postedAt!.getTime()).toBe(180 * 60_000);
  });

  it('reminds the admins once when a prepared pair is not published within 10 minutes', async () => {
    const battle = await openBattle(ctx);
    await entries(2);
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    await ctx.services.battles.tick();
    expect(adminTexts().some((t) => t.includes('ещё не опубликован'))).toBe(false);
    await ctx.prisma.duel.updateMany({ data: { readyAt: new Date(Date.now() - 11 * 60_000) } });
    await ctx.services.battles.tick();
    await ctx.services.battles.tick();
    expect(adminTexts().filter((t) => t.includes('⏰ Финал — пост ещё не опубликован'))).toHaveLength(1);
  });
});
