import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppQueues } from '../../src/queue/queues.js';
import { startWorkers } from '../../src/queue/workers.js';
import { createServices, type Services } from '../../src/services.js';
import { ADMIN_TG_ID, CHANNEL, resetDatabase, testPrisma } from '../helpers/context.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { FakeTelegram, silentLogger, telegramError } from '../helpers/fakes.js';
import { makeUniqueJpeg } from '../helpers/images.js';
import { hashBuffer } from '../../src/modules/photos/image-validator.js';

const prisma = testPrisma();
let queues: AppQueues;
let workers: Worker[];
let services: Services;
let telegram: FakeTelegram;

beforeEach(async () => {
  await resetDatabase(prisma);
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
  redis.disconnect();

  const prefix = `test-${Date.now()}`;
  telegram = new FakeTelegram();
  queues = new AppQueues({ redisUrl: TEST_REDIS_URL, prefix, publishMaxAttempts: 3, timeZone: 'Europe/Kyiv' });
  services = createServices({
    prisma,
    telegram,
    scheduler: queues,
    channel: CHANNEL,
    bot: { username: 'photobattle_bot' },
    logger: silentLogger,
    env: { DEFAULT_LANGUAGE: 'ru', TIMEZONE: 'Europe/Kyiv', PUBLISH_MAX_ATTEMPTS: 3, BROADCAST_RATE_PER_SECOND: 30, CARD_CURRENCY: 'UAH' },
  });
  await services.settings.ensureDefaults();
  await services.admins.syncOwners([ADMIN_TG_ID]);
  workers = startWorkers(services, { redisUrl: TEST_REDIS_URL, prefix, retryBaseMs: 100, draftTtlHours: 24 }, silentLogger);
});

afterEach(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await queues.close();
});

async function queuePhoto(seed: number) {
  const { user: registered } = await services.users.upsertFromTelegram({ id: 70_000 + seed, first_name: 'Q' });
  const user = await services.users.giveConsent(registered.id);
  const buffer = await makeUniqueJpeg(seed);
  const draft = await services.photos.createDraft(user, {
    source: 'PHOTO',
    fileId: `f${seed}`,
    fileUniqueId: `u${seed}`,
    contentHash: hashBuffer(buffer),
    mimeType: 'image/jpeg',
    width: 400,
    height: 400,
    fileSize: buffer.length,
  });
  await services.photos.confirm(draft.id, user.id); // triggers an immediate publication tick
  return draft;
}

async function waitFor<T>(fn: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out, last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('BullMQ publication pipeline', () => {
  it('6. retries transient Telegram errors with backoff and publishes exactly once', async () => {
    telegram.failNext('sendPhoto', telegramError(502, 'Bad Gateway'), telegramError(500, 'Internal Server Error'));
    const photo = await queuePhoto(1);

    const published = await waitFor(
      () => prisma.photo.findUniqueOrThrow({ where: { id: photo.id } }),
      (p) => p.status === 'PUBLISHED',
    );
    expect(published.status).toBe('PUBLISHED');
    expect(telegram.callsOf('sendPhoto').filter((c) => c.chatId === CHANNEL.id)).toHaveLength(3);
    expect(await prisma.publication.count({ where: { photoId: photo.id } })).toBe(1);
    const item = await prisma.publicationQueue.findUniqueOrThrow({ where: { photoId: photo.id } });
    expect(item).toMatchObject({ status: 'DONE', attempts: 3 });

    // Further ticks must not publish it again.
    await queues.triggerPublishTick();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(telegram.callsOf('sendPhoto').filter((c) => c.chatId === CHANNEL.id)).toHaveLength(3);
  });

  it('stops after the attempt limit and marks the photo as failed', async () => {
    telegram.failNext('sendPhoto', telegramError(500, 'a'), telegramError(500, 'b'), telegramError(500, 'c'), telegramError(500, 'd'));
    const photo = await queuePhoto(2);
    const failed = await waitFor(
      () => prisma.photo.findUniqueOrThrow({ where: { id: photo.id } }),
      (p) => p.status === 'FAILED',
    );
    expect(failed.status).toBe('FAILED');
    expect(telegram.callsOf('sendPhoto').filter((c) => c.chatId === CHANNEL.id)).toHaveLength(3);
  });

  it('debounces vote counter refreshes into channel edits', async () => {
    const photo = await queuePhoto(3);
    await waitFor(() => prisma.photo.findUniqueOrThrow({ where: { id: photo.id } }), (p) => p.status === 'PUBLISHED');
    for (let i = 0; i < 5; i += 1) {
      const { user } = await services.users.upsertFromTelegram({ id: 80_000 + i, first_name: 'V' });
      await services.votes.toggle(photo.id, user);
    }
    await waitFor(async () => telegram.callsOf('editMessageReplyMarkup').length, (n) => n >= 1, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const edits = telegram.callsOf('editMessageReplyMarkup');
    expect(edits.length).toBeLessThan(5);
    expect(JSON.stringify(edits.at(-1)?.args[1])).toContain('Поддержать · 5');
  });
});
