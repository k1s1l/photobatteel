import { createPrisma } from '../../src/lib/prisma.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createServices, type Services } from '../../src/services.js';
import type { ChannelInfo } from '../../src/modules/contracts.js';
import { hashBuffer } from '../../src/modules/photos/image-validator.js';
import { assertTestDatabase, TEST_DATABASE_URL } from './env.js';
import { FakeScheduler, FakeTelegram, silentLogger } from './fakes.js';
import { makeUniqueJpeg } from './images.js';

export const CHANNEL: ChannelInfo = { id: -1001234567890, username: 'photobattle_test' };
export const ADMIN_TG_ID = 900_000_001;

export interface TestContext {
  prisma: PrismaClient;
  telegram: FakeTelegram;
  scheduler: FakeScheduler;
  services: Services;
}

let shared: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  assertTestDatabase();
  shared ??= createPrisma(TEST_DATABASE_URL);
  return shared;
}

const TABLES = ['ActivityLog', 'Vote', 'Publication', 'PublicationQueue', 'Broadcast', 'Battle', 'Photo', 'Admin', 'BotSettings', 'User'];

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export async function createTestContext(options: { maxAttempts?: number } = {}): Promise<TestContext> {
  const prisma = testPrisma();
  await resetDatabase(prisma);
  const telegram = new FakeTelegram();
  const scheduler = new FakeScheduler();
  const services = createServices({
    prisma,
    telegram,
    scheduler,
    channel: CHANNEL,
    bot: { username: 'photobattle_bot' },
    logger: silentLogger,
    env: { DEFAULT_LANGUAGE: 'ru', TIMEZONE: 'Europe/Kyiv', PUBLISH_MAX_ATTEMPTS: options.maxAttempts ?? 3, BROADCAST_RATE_PER_SECOND: 30 },
  });
  await services.settings.ensureDefaults();
  await services.admins.syncOwners([ADMIN_TG_ID]);
  return { prisma, telegram, scheduler, services };
}

let telegramIdSeq = 100_000;

export async function createUser(ctx: TestContext, overrides: { username?: string; consent?: boolean } = {}) {
  telegramIdSeq += 1;
  const { user } = await ctx.services.users.upsertFromTelegram({
    id: telegramIdSeq,
    first_name: `User${telegramIdSeq}`,
    username: overrides.username ?? `user${telegramIdSeq}`,
  });
  return overrides.consent === false ? user : ctx.services.users.giveConsent(user.id);
}

export async function createAdmin(ctx: TestContext) {
  const { user } = await ctx.services.users.upsertFromTelegram({ id: ADMIN_TG_ID, first_name: 'Admin', username: 'admin' });
  await ctx.services.admins.linkUser(ADMIN_TG_ID, user.id);
  return user;
}

let photoSeq = 0;

/** Creates a draft photo with a unique image hash. */
export async function createDraft(ctx: TestContext, user: Awaited<ReturnType<typeof createUser>>) {
  photoSeq += 1;
  const buffer = await makeUniqueJpeg(photoSeq);
  return ctx.services.photos.createDraft(user, {
    source: 'PHOTO',
    fileId: `file-${photoSeq}`,
    fileUniqueId: `unique-file-${photoSeq}`,
    contentHash: hashBuffer(buffer),
    mimeType: 'image/jpeg',
    width: 400,
    height: 400,
    fileSize: buffer.length,
  });
}

/** Draft → confirmed (QUEUED unless moderation is on). */
export async function createQueuedPhoto(ctx: TestContext, user: Awaited<ReturnType<typeof createUser>>) {
  const draft = await createDraft(ctx, user);
  await ctx.services.photos.confirm(draft.id, user.id);
  return draft;
}
