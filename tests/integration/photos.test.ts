import { beforeEach, describe, expect, it } from 'vitest';
import { hashBuffer } from '../../src/modules/photos/image-validator.js';
import { createAdmin, createDraft, createQueuedPhoto, createTestContext, createUser, type TestContext } from '../helpers/context.js';
import { makeUniqueJpeg } from '../helpers/images.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

describe('2-4. photo intake, confirmation and queueing', () => {
  it('creates a draft that is not queued until confirmed', async () => {
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    expect(draft.status).toBe('DRAFT');
    expect(draft.id).toBeGreaterThan(0);
    expect(await ctx.prisma.publicationQueue.count()).toBe(0);
    // Unconfirmed photos are never claimed for publication.
    expect(await ctx.services.publications.claimNext()).toBeNull();
  });

  it('requires consent before accepting photos', async () => {
    const user = await createUser(ctx, { consent: false });
    await expect(ctx.services.photos.assertCanSubmit(user)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('confirms a draft, adds it to the queue and counts it', async () => {
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    const result = await ctx.services.photos.confirm(draft.id, user.id);

    expect(result.photo.status).toBe('QUEUED');
    expect(result.moderation).toBe(false);
    expect(result.queuePosition).toBe(1);
    const item = await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: draft.id } });
    expect(item.status).toBe('WAITING');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).photosSubmitted).toBe(1);
    expect(ctx.scheduler.ticks).toBe(1);
  });

  it('cancels a draft so it can never be published', async () => {
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    await ctx.services.photos.cancelDraft(draft.id, user.id);
    await expect(ctx.services.photos.confirm(draft.id, user.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await ctx.prisma.publicationQueue.count()).toBe(0);
  });

  it('sends confirmed photos to moderation when enabled', async () => {
    await ctx.services.settings.update({ moderationEnabled: true }, null);
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    const result = await ctx.services.photos.confirm(draft.id, user.id);
    expect(result.photo.status).toBe('PENDING_MODERATION');
    expect(await ctx.prisma.publicationQueue.count()).toBe(0);

    await ctx.services.photos.approve(draft.id, admin.id);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('QUEUED');
    expect(await ctx.prisma.publicationQueue.count({ where: { status: 'WAITING' } })).toBe(1);
    await expect(ctx.services.photos.approve(draft.id, admin.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('rejects a queued photo and notifies the author', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    await ctx.services.photos.reject(photo.id, admin.id, 'Низкое качество');
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('REJECTED');
    expect((await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: photo.id } })).status).toBe('CANCELLED');
    const dm = ctx.telegram.callsOf('sendMessage').find((call) => call.chatId === Number(user.telegramId));
    expect(String(dm?.args[0])).toContain('Низкое качество');
  });
});

describe('7. duplicate protection', () => {
  it('makes confirmation idempotent under repeated and concurrent presses', async () => {
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => ctx.services.photos.confirm(draft.id, user.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.prisma.publicationQueue.count()).toBe(1);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).photosSubmitted).toBe(1);
  });

  it('rejects the same image submitted again (by anyone)', async () => {
    const user = await createUser(ctx);
    const other = await createUser(ctx);
    const buffer = await makeUniqueJpeg(424242);
    const input = {
      source: 'PHOTO' as const,
      fileId: 'f1',
      fileUniqueId: 'u1',
      contentHash: hashBuffer(buffer),
      mimeType: 'image/jpeg',
      width: 400,
      height: 400,
      fileSize: buffer.length,
    };
    const first = await ctx.services.photos.createDraft(user, input);
    await ctx.services.photos.confirm(first.id, user.id);
    await expect(ctx.services.photos.createDraft(user, { ...input, fileId: 'f2', fileUniqueId: 'u2' })).rejects.toMatchObject({ code: 'DUPLICATE_PHOTO' });
    await expect(ctx.services.photos.createDraft(other, { ...input, contentHash: 'x'.repeat(64) })).rejects.toMatchObject({ code: 'DUPLICATE_PHOTO' });
  });

  it('keeps only one active draft per user', async () => {
    const user = await createUser(ctx);
    const first = await createDraft(ctx, user);
    await createDraft(ctx, user);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELLED');
  });

  it('enforces the daily limit', async () => {
    await ctx.services.settings.update({ maxPhotosPerDay: 2, maxQueuedPerUser: 0 }, null);
    const user = await createUser(ctx);
    await createQueuedPhoto(ctx, user);
    await createQueuedPhoto(ctx, user);
    await expect(createDraft(ctx, user)).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
  });
});

describe('10. photo deletion', () => {
  it('lets the author delete a queued photo and removes it from the queue', async () => {
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);
    const result = await ctx.services.photos.delete(photo.id, { userId: user.id, isAdmin: false });
    expect(result.channelRemoved).toBeNull();
    expect(result.photo.status).toBe('DELETED');
    expect((await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: photo.id } })).status).toBe('CANCELLED');
  });

  it("forbids deleting someone else's photo", async () => {
    const owner = await createUser(ctx);
    const stranger = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, owner);
    await expect(ctx.services.photos.delete(photo.id, { userId: stranger.id, isAdmin: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deletes a published photo from the channel and discounts its votes', async () => {
    const admin = await createAdmin(ctx);
    const owner = await createUser(ctx);
    const voter = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, owner);
    const item = await ctx.services.publications.claimNext();
    await ctx.services.publications.processItem(item!.id);
    await ctx.services.votes.toggle(photo.id, voter);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).votesReceived).toBe(1);

    const result = await ctx.services.photos.delete(photo.id, { userId: admin.id, isAdmin: true });
    expect(result.channelRemoved).toBe(true);
    const publication = await ctx.prisma.publication.findUniqueOrThrow({ where: { photoId: photo.id } });
    expect(ctx.telegram.callsOf('deleteMessage')[0]).toMatchObject({ chatId: -1001234567890, args: [publication.messageId] });
    expect(publication.removedAt).not.toBeNull();
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).votesReceived).toBe(0);
    await expect(ctx.services.votes.toggle(photo.id, voter)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports when the channel post cannot be removed', async () => {
    const owner = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, owner);
    await ctx.services.publications.processItem((await ctx.services.publications.claimNext())!.id);
    const { telegramError } = await import('../helpers/fakes.js');
    ctx.telegram.failNext('deleteMessage', telegramError(400, "Bad Request: message can't be deleted"));
    const result = await ctx.services.photos.delete(photo.id, { userId: owner.id, isAdmin: false });
    expect(result.channelRemoved).toBe(false);
    expect(result.photo.status).toBe('DELETED');
  });

  it('deletes all data of a user on request', async () => {
    const user = await createUser(ctx);
    await createQueuedPhoto(ctx, user);
    await createQueuedPhoto(ctx, user);
    expect(await ctx.services.photos.deleteAllForUser(user.id)).toBe(2);
    expect(await ctx.prisma.photo.count({ where: { userId: user.id, status: { not: 'DELETED' } } })).toBe(0);
  });
});
