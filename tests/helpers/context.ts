import { createPrisma } from '../../src/lib/prisma.js';
import type { Battle, PrismaClient, User } from '../../src/generated/prisma/client.js';
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

const TABLES = ['ActivityLog', 'PaidVote', 'Payment', 'VotePackage', 'DuelVote', 'Duel', 'Broadcast', 'Photo', 'Battle', 'Admin', 'BotSettings', 'User'];

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export const TEST_ENV = {
  DEFAULT_LANGUAGE: 'ru' as const,
  TIMEZONE: 'Europe/Kyiv',
  BROADCAST_RATE_PER_SECOND: 30,
  CARD_CURRENCY: 'UAH',
  MAX_TIEBREAKS: 2,
  PAYMENT_PROVIDER_TOKEN: 'test-provider-token',
};

export async function createTestContext(): Promise<TestContext> {
  const prisma = testPrisma();
  await resetDatabase(prisma);
  const telegram = new FakeTelegram();
  const scheduler = new FakeScheduler();
  const services = createServices({ prisma, telegram, scheduler, channel: CHANNEL, bot: { username: 'photobattle_bot' }, logger: silentLogger, env: TEST_ENV });
  await services.settings.ensureDefaults();
  await services.admins.syncOwners([ADMIN_TG_ID]);
  await services.payments.ensureDefaultPackages();
  return { prisma, telegram, scheduler, services };
}

let telegramIdSeq = 100_000;

export async function createUser(ctx: TestContext, overrides: { username?: string; consent?: boolean } = {}): Promise<User> {
  telegramIdSeq += 1;
  const { user } = await ctx.services.users.upsertFromTelegram({
    id: telegramIdSeq,
    first_name: `User${telegramIdSeq}`,
    username: overrides.username ?? `user${telegramIdSeq}`,
  });
  return overrides.consent === false ? user : ctx.services.users.giveConsent(user.id);
}

export async function createAdmin(ctx: TestContext): Promise<User> {
  const { user } = await ctx.services.users.upsertFromTelegram({ id: ADMIN_TG_ID, first_name: 'Admin', username: 'admin' });
  await ctx.services.admins.linkUser(ADMIN_TG_ID, user.id);
  return user;
}

/** Schedules a battle that accepts entries (start in the future). */
export async function openBattle(ctx: TestContext, options: { roundMinutes?: number; tiebreakMinutes?: number } = {}): Promise<Battle> {
  return ctx.services.battles.schedule({
    title: 'Осень',
    startsAt: new Date(Date.now() + 60 * 60_000),
    roundMinutes: options.roundMinutes ?? 60,
    tiebreakMinutes: options.tiebreakMinutes ?? 10,
    createdById: null,
  });
}

let fileSeq = 0;

/** Creates a draft photo with a unique image; the image is downloadable from the fake Telegram. */
export async function createDraft(ctx: TestContext, user: User, mediaType: 'PHOTO' | 'VIDEO' = 'PHOTO') {
  fileSeq += 1;
  const buffer = await makeUniqueJpeg(fileSeq);
  const fileId = `file-${fileSeq}`;
  ctx.telegram.files.set(fileId, buffer);
  return ctx.services.photos.createDraft(user, {
    mediaType,
    source: mediaType === 'VIDEO' ? 'VIDEO' : 'PHOTO',
    fileId,
    fileUniqueId: `unique-file-${fileSeq}`,
    contentHash: mediaType === 'VIDEO' ? `video:unique-file-${fileSeq}` : hashBuffer(buffer),
    mimeType: mediaType === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
    width: 400,
    height: 400,
    fileSize: buffer.length,
    ...(mediaType === 'VIDEO' ? { durationSec: 15 } : {}),
  });
}

/** Draft → confirmed entry of the open battle. */
export async function createEntry(ctx: TestContext, user: User, mediaType: 'PHOTO' | 'VIDEO' = 'PHOTO') {
  const draft = await createDraft(ctx, user, mediaType);
  await ctx.services.photos.confirm(draft.id, user.id);
  return draft;
}

/** Moves the battle start into the past and runs the tick: entries are paired into round 1. */
export async function startBattle(ctx: TestContext, battleId: number): Promise<void> {
  await ctx.prisma.battle.update({ where: { id: battleId }, data: { startsAt: new Date(Date.now() - 1000) } });
  await ctx.services.battles.tick();
}

/** Prepares every pending duel post for the admins (what the duel worker does). */
export async function preparePendingDuels(ctx: TestContext): Promise<void> {
  const pending = await ctx.prisma.duel.findMany({ where: { status: 'PENDING' }, orderBy: [{ round: 'asc' }, { position: 'asc' }] });
  for (const duel of pending) await ctx.services.battles.prepareDuel(duel.id, duel.stage);
}

/** What an admin does: forwards each prepared post to the channel; the bot sees the channel post. */
export async function publishReadyDuels(ctx: TestContext): Promise<number[]> {
  const ready = await ctx.prisma.duel.findMany({ where: { status: 'READY' }, include: { photoA: true, photoB: true }, orderBy: [{ round: 'asc' }, { position: 'asc' }] });
  const posts: number[] = [];
  for (const duel of ready) {
    const messageId = ctx.telegram.nextId();
    posts.push(messageId);
    const files = duel.preparedFileUniqueId ? [duel.preparedFileUniqueId] : [duel.photoA.fileUniqueId, duel.photoB!.fileUniqueId];
    await ctx.services.battles.linkChannelPost({ messageId, fileUniqueIds: files });
  }
  return posts;
}

/** Prepare + publish: every pending duel becomes live. */
export async function postPendingDuels(ctx: TestContext): Promise<void> {
  await preparePendingDuels(ctx);
  await publishReadyDuels(ctx);
}

/** Expires every active duel and runs the tick. */
export async function expireDuels(ctx: TestContext): Promise<void> {
  await ctx.prisma.duel.updateMany({ where: { status: 'ACTIVE' }, data: { endsAt: new Date(Date.now() - 1000) } });
  await ctx.services.battles.tick();
}
