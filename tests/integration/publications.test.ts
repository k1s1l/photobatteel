import { beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL, createAdmin, createDraft, createQueuedPhoto, createTestContext, createUser, type TestContext } from '../helpers/context.js';
import { telegramError } from '../helpers/fakes.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext({ maxAttempts: 3 });
});

async function publishNext() {
  const result = await ctx.services.publications.tick();
  const itemId = ctx.scheduler.publications.at(-1);
  return { result, outcome: itemId ? await ctx.services.publications.processItem(itemId) : undefined };
}

describe('5. publication', () => {
  it('publishes the photo to the channel in the required format and records message_id', async () => {
    const user = await createUser(ctx, { username: 'kate' });
    const photo = await createQueuedPhoto(ctx, user);
    const { result, outcome } = await publishNext();

    expect(result).toBe('claimed');
    expect(outcome?.status).toBe('published');
    const send = ctx.telegram.callsOf('sendPhoto')[0]!;
    expect(send.chatId).toBe(CHANNEL.id);
    const options = send.args[1] as { caption: string; replyMarkup: { inline_keyboard: { callback_data: string }[][] } };
    expect(options.caption).toContain('PHOTO BATTLE');
    expect(options.caption).toContain('Участник: @kate');
    expect(options.caption).toContain(`ID фотографии: #000${photo.id}`);
    expect(options.replyMarkup.inline_keyboard[0]?.[0]?.callback_data).toBe(`v:${photo.id}`);

    const publication = await ctx.prisma.publication.findUniqueOrThrow({ where: { photoId: photo.id } });
    expect(publication.messageId).toBe(outcome?.status === 'published' ? outcome.messageId : -1);
    expect(publication.channelId).toBe(BigInt(CHANNEL.id));
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('PUBLISHED');
    expect((await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: photo.id } })).status).toBe('DONE');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).photosPublished).toBe(1);
    // The author gets a notification with a link to the post.
    expect(String(ctx.telegram.callsOf('sendMessage').find((c) => c.chatId === Number(user.telegramId))?.args[0])).toContain('t.me/photobattle_test/');
  });

  it('keeps FIFO order and publishes one photo per interval', async () => {
    const user = await createUser(ctx);
    await ctx.services.settings.update({ maxQueuedPerUser: 0, maxPhotosPerDay: 0 }, null);
    const first = await createQueuedPhoto(ctx, user);
    const second = await createQueuedPhoto(ctx, user);

    await publishNext();
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PUBLISHED');
    // Interval (15 min by default) has not elapsed: nothing is claimed.
    expect(await ctx.services.publications.tick()).toBe('interval');
    const later = new Date(Date.now() + 15 * 60_000);
    expect(await ctx.services.publications.tick(later)).toBe('claimed');
    await ctx.services.publications.processItem(ctx.scheduler.publications.at(-1)!);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('PUBLISHED');
    expect(await ctx.services.publications.tick(new Date(Date.now() + 60 * 60_000))).toBe('empty');
  });

  it('does not publish while paused or in manual mode, but manual publication works', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    await ctx.services.settings.update({ publishingPaused: true }, admin.id);
    expect(await ctx.services.publications.tick()).toBe('paused');
    await ctx.services.settings.update({ publishingPaused: false, publishIntervalMinutes: 0 }, admin.id);
    expect(await ctx.services.publications.tick()).toBe('paused');

    await ctx.services.publications.publishNow(photo.id, admin.id);
    const outcome = await ctx.services.publications.processItem(ctx.scheduler.publications.at(-1)!);
    expect(outcome.status).toBe('published');
    const publication = await ctx.prisma.publication.findUniqueOrThrow({ where: { photoId: photo.id } });
    expect(publication).toMatchObject({ manual: true, publishedById: admin.id });
  });

  it('never publishes drafts or cancelled photos', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    await expect(ctx.services.publications.publishNow(draft.id, admin.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await ctx.services.publications.tick()).toBe('empty');
    expect(ctx.telegram.callsOf('sendPhoto')).toHaveLength(0);
  });
});

describe('6. retries after errors', () => {
  it('asks for a retry on transient errors and succeeds later', async () => {
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    ctx.telegram.failNext('sendPhoto', telegramError(502, 'Bad Gateway'));
    await ctx.services.publications.tick();
    const itemId = ctx.scheduler.publications.at(-1)!;

    const first = await ctx.services.publications.processItem(itemId);
    expect(first.status).toBe('retry');
    const item = await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ status: 'PROCESSING', attempts: 1, lastError: 'Bad Gateway' });
    // While an item is retrying, the next photo is not claimed (order is preserved).
    expect(await ctx.services.publications.tick()).toBe('in_flight');

    const second = await ctx.services.publications.processItem(itemId);
    expect(second.status).toBe('published');
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('PUBLISHED');
  });

  it("passes Telegram's retry_after for 429 responses", async () => {
    const user = await createUser(ctx);
    await createQueuedPhoto(ctx, user);
    ctx.telegram.failNext('sendPhoto', telegramError(429, 'Too Many Requests: retry after 9', 9));
    await ctx.services.publications.tick();
    const outcome = await ctx.services.publications.processItem(ctx.scheduler.publications.at(-1)!);
    expect(outcome).toMatchObject({ status: 'retry', retryAfterMs: 9000 });
  });

  it('gives up after the attempt limit and notifies admins', async () => {
    await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    ctx.telegram.failNext('sendPhoto', telegramError(500, 'Internal'), telegramError(500, 'Internal'), telegramError(500, 'Internal'));
    await ctx.services.publications.tick();
    const itemId = ctx.scheduler.publications.at(-1)!;
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push((await ctx.services.publications.processItem(itemId)).status);
    expect(outcomes).toEqual(['retry', 'retry', 'failed']);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('FAILED');
    expect(ctx.telegram.callsOf('sendMessage').some((c) => String(c.args[0]).includes('Не удалось опубликовать'))).toBe(true);
  });

  it('fails immediately on permanent errors and can be requeued by an admin', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    ctx.telegram.failNext('sendPhoto', telegramError(403, 'Forbidden: bot is not a member of the channel chat'));
    await ctx.services.publications.tick();
    const outcome = await ctx.services.publications.processItem(ctx.scheduler.publications.at(-1)!);
    expect(outcome.status).toBe('failed');

    await ctx.services.photos.requeue(photo.id, admin.id);
    expect(await ctx.services.publications.tick()).toBe('claimed');
    expect((await ctx.services.publications.processItem(ctx.scheduler.publications.at(-1)!)).status).toBe('published');
  });
});

describe('7. no double publication', () => {
  it('ignores repeated processing of the same item', async () => {
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    await ctx.services.publications.tick();
    const itemId = ctx.scheduler.publications.at(-1)!;
    const results = await Promise.all([1, 2].map(() => ctx.services.publications.processItem(itemId)));
    // Concurrency is 1 in production; even if two runs race, only one Publication row can exist.
    expect(await ctx.prisma.publication.count({ where: { photoId: photo.id } })).toBe(1);
    expect(results.filter((r) => r.status === 'published').length).toBeGreaterThanOrEqual(1);
    const again = await ctx.services.publications.processItem(itemId);
    expect(again.status).toBe('skipped');
    await ctx.services.publications.publishNow(photo.id, (await createAdmin(ctx)).id).catch((e: { code?: string }) => expect(e.code).toBe('INVALID_STATE'));
  });

  it('removes the post if the photo was withdrawn while being sent', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    await ctx.services.publications.tick();
    const itemId = ctx.scheduler.publications.at(-1)!;
    // Simulate the photo being rejected after the send started.
    const original = ctx.telegram.sendPhoto.bind(ctx.telegram);
    ctx.telegram.sendPhoto = async (...args) => {
      const sent = await original(...args);
      await ctx.prisma.photo.update({ where: { id: photo.id }, data: { status: 'REJECTED', moderatedById: admin.id } });
      return sent;
    };
    const outcome = await ctx.services.publications.processItem(itemId);
    expect(outcome.status).toBe('skipped');
    expect(ctx.telegram.callsOf('deleteMessage')).toHaveLength(1);
    expect(await ctx.prisma.publication.count()).toBe(0);
  });
});
