import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TG_ID, createAdmin, createQueuedPhoto, createTestContext, createUser, type TestContext } from '../helpers/context.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});

describe('1. user registration', () => {
  it('registers a new user once and refreshes the profile', async () => {
    const first = await ctx.services.users.upsertFromTelegram({ id: 555, first_name: 'Ann', username: 'ann' });
    expect(first.isNew).toBe(true);
    expect(first.user).toMatchObject({ telegramId: 555n, username: 'ann', firstName: 'Ann', isBlocked: false, photosSubmitted: 0 });

    const second = await ctx.services.users.upsertFromTelegram({ id: 555, first_name: 'Anna', username: 'anna' });
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.username).toBe('anna');
    expect(await ctx.prisma.user.count()).toBe(1);
    expect(await ctx.prisma.activityLog.count({ where: { action: 'USER_REGISTERED' } })).toBe(1);
  });

  it('rejects invalid Telegram ids', async () => {
    await expect(ctx.services.users.upsertFromTelegram({ id: -5, first_name: 'X' })).rejects.toThrow();
  });

  it('handles concurrent first contact without duplicates', async () => {
    await Promise.all([1, 2, 3].map(() => ctx.services.users.upsertFromTelegram({ id: 777, first_name: 'Race' })));
    expect(await ctx.prisma.user.count({ where: { telegramId: 777n } })).toBe(1);
  });
});

describe('8. admin rights', () => {
  it('grants rights only to ADMIN_IDS owners', async () => {
    expect(await ctx.services.admins.isAdmin(ADMIN_TG_ID)).toBe(true);
    expect(await ctx.services.admins.isAdmin(123)).toBe(false);
  });

  it('denies and audits access for non-admins', async () => {
    await expect(ctx.services.admins.assertAdmin(123)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const log = await ctx.prisma.activityLog.findFirst({ where: { action: 'ADMIN_ACCESS_DENIED' } });
    expect(log?.telegramId).toBe(123n);
  });

  it('revokes owners removed from ADMIN_IDS', async () => {
    await ctx.services.admins.syncOwners([42]);
    expect(await ctx.services.admins.isAdmin(ADMIN_TG_ID)).toBe(false);
    expect(await ctx.services.admins.isAdmin(42)).toBe(true);
  });
});

describe('9. blocking', () => {
  it('blocks a user, withdraws their queued photos and forbids new submissions', async () => {
    const admin = await createAdmin(ctx);
    const user = await createUser(ctx);
    const photo = await createQueuedPhoto(ctx, user);

    const { user: blocked, cancelledPhotos } = await ctx.services.users.block(user.id, admin.id, 'spam');
    expect(blocked.isBlocked).toBe(true);
    expect(cancelledPhotos).toBe(1);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('REJECTED');
    expect((await ctx.prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: photo.id } })).status).toBe('CANCELLED');
    await expect(ctx.services.photos.assertCanSubmit(blocked)).rejects.toMatchObject({ code: 'USER_BLOCKED' });
    await expect(ctx.services.users.block(user.id, admin.id, 'again')).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const unblocked = await ctx.services.users.unblock(user.id, admin.id);
    expect(unblocked.isBlocked).toBe(false);
    expect(await ctx.prisma.activityLog.count({ where: { action: { in: ['USER_BLOCKED', 'USER_UNBLOCKED'] } } })).toBe(2);
  });

  it('finds users by id, @username and photo id', async () => {
    const user = await createUser(ctx, { username: 'FindMe' });
    const photo = await createQueuedPhoto(ctx, user);
    expect((await ctx.services.users.findByQuery(String(user.telegramId)))?.id).toBe(user.id);
    expect((await ctx.services.users.findByQuery('@findme'))?.id).toBe(user.id);
    expect((await ctx.services.users.findByQuery(`#${photo.id}`))?.id).toBe(user.id);
    expect(await ctx.services.users.findByQuery('@nobody_here')).toBeNull();
  });
});
