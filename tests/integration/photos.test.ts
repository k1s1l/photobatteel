import { beforeEach, describe, expect, it } from 'vitest';
import { hashBuffer } from '../../src/modules/photos/image-validator.js';
import { createAdmin, createDraft, createEntry, createTestContext, createUser, openBattle, startBattle, postPendingDuels, type TestContext } from '../helpers/context.js';
import { makeUniqueJpeg } from '../helpers/images.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

describe('entries are collected only for a scheduled battle', () => {
  it('refuses submissions when no battle is open', async () => {
    const user = await createUser(ctx);
    await expect(ctx.services.photos.assertCanSubmit(user)).rejects.toMatchObject({ code: 'NO_ACTIVE_BATTLE' });
  });

  it('requires consent', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx, { consent: false });
    await expect(ctx.services.photos.assertCanSubmit(user)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('accepts a confirmed photo into the open battle without publishing anything', async () => {
    const battle = await openBattle(ctx);
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    expect(draft.status).toBe('DRAFT');
    const result = await ctx.services.photos.confirm(draft.id, user.id);
    expect(result.photo).toMatchObject({ status: 'ACCEPTED', battleId: battle.id });
    expect(result.battle.id).toBe(battle.id);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).photosSubmitted).toBe(1);
    // Nothing goes to the channel before the start (only the battle announcement).
    expect(ctx.telegram.callsOf('sendPhoto')).toHaveLength(0);
    expect(ctx.telegram.callsOf('sendMediaGroup')).toHaveLength(0);
  });

  it('accepts videos', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx);
    const entry = await createEntry(ctx, user, 'VIDEO');
    expect(await ctx.prisma.photo.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ mediaType: 'VIDEO', status: 'ACCEPTED', durationSec: 15 });
  });

  it('enforces one entry per battle by default', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx);
    await createEntry(ctx, user);
    await expect(createDraft(ctx, user)).rejects.toMatchObject({ code: 'BATTLE_LIMIT', params: { limit: 1 } });
    await ctx.services.settings.update({ maxPhotosPerBattle: 2 }, null);
    await expect(createEntry(ctx, user)).resolves.toBeDefined();
  });

  it('closes submissions once the battle has started', async () => {
    const battle = await openBattle(ctx);
    const user = await createUser(ctx);
    const late = await createDraft(ctx, user);
    await ctx.prisma.battle.update({ where: { id: battle.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    await expect(ctx.services.photos.confirm(late.id, user.id)).rejects.toMatchObject({ code: 'NO_ACTIVE_BATTLE' });
  });
});

describe('duplicate protection', () => {
  it('makes confirmation idempotent under concurrent presses', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx);
    const draft = await createDraft(ctx, user);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => ctx.services.photos.confirm(draft.id, user.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).photosSubmitted).toBe(1);
  });

  it('rejects the same file submitted again, by anyone', async () => {
    await openBattle(ctx);
    await ctx.services.settings.update({ maxPhotosPerBattle: 0 }, null);
    const user = await createUser(ctx);
    const other = await createUser(ctx);
    const buffer = await makeUniqueJpeg(777);
    const input = {
      mediaType: 'PHOTO' as const,
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
    await expect(ctx.services.photos.createDraft(other, { ...input, contentHash: 'other' })).rejects.toMatchObject({ code: 'DUPLICATE_PHOTO' });
  });

  it('keeps only one draft per user', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx);
    const first = await createDraft(ctx, user);
    await createDraft(ctx, user);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELLED');
  });
});

describe('moderation', () => {
  it('holds entries for moderation, approves and rejects them', async () => {
    await openBattle(ctx);
    await ctx.services.settings.update({ moderationEnabled: true, maxPhotosPerBattle: 0 }, null);
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const first = await createEntry(ctx, user);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PENDING_MODERATION');
    await ctx.services.photos.approve(first.id, admin.id);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('ACCEPTED');

    const second = await createEntry(ctx, user);
    await ctx.services.photos.reject(second.id, admin.id, 'Низкое качество');
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('REJECTED');
    expect(ctx.telegram.callsOf('sendMessage').some((c) => String(c.args[0]).includes('Низкое качество'))).toBe(true);
  });

  it('drops entries still waiting for moderation when the battle starts', async () => {
    const battle = await openBattle(ctx);
    await ctx.services.settings.update({ moderationEnabled: true }, null);
    const pending = await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('CANCELLED');
  });
});

describe('deletion', () => {
  it('lets the author delete an entry before the start', async () => {
    await openBattle(ctx);
    const user = await createUser(ctx);
    const entry = await createEntry(ctx, user);
    const result = await ctx.services.photos.delete(entry.id, { userId: user.id, isAdmin: false });
    expect(result).toMatchObject({ forfeited: false, photo: { status: 'DELETED' } });
  });

  it("forbids deleting someone else's entry", async () => {
    await openBattle(ctx);
    const entry = await createEntry(ctx, await createUser(ctx));
    const stranger = await createUser(ctx);
    await expect(ctx.services.photos.delete(entry.id, { userId: stranger.id, isAdmin: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('forfeits the duel when an entry is deleted during the battle', async () => {
    const battle = await openBattle(ctx);
    const admin = await createAdmin(ctx);
    const a = await createEntry(ctx, await createUser(ctx));
    const b = await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();

    const result = await ctx.services.photos.delete(a.id, { userId: admin.id, isAdmin: true });
    expect(result.forfeited).toBe(true);
    const finished = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(finished).toMatchObject({ status: 'FINISHED', winnerPhotoId: b.id });
    expect(ctx.telegram.callsOf('deleteMessage').map((c) => c.args[0])).toContain(duel.messageId);
  });

  it('deletes all data of a user on request', async () => {
    await openBattle(ctx);
    await ctx.services.settings.update({ maxPhotosPerBattle: 0 }, null);
    const user = await createUser(ctx);
    await createEntry(ctx, user);
    await createEntry(ctx, user);
    expect(await ctx.services.photos.deleteAllForUser(user.id)).toBe(2);
  });
});
