import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppQueues } from '../../src/queue/queues.js';
import { startWorkers } from '../../src/queue/workers.js';
import { createServices, type Services } from '../../src/services.js';
import { hashBuffer } from '../../src/modules/photos/image-validator.js';
import { ADMIN_TG_ID, CHANNEL, resetDatabase, TEST_ENV, testPrisma } from '../helpers/context.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { FakeTelegram, silentLogger, telegramError } from '../helpers/fakes.js';
import { makeUniqueJpeg } from '../helpers/images.js';

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
  queues = new AppQueues({ redisUrl: TEST_REDIS_URL, prefix, postMaxAttempts: 4 });
  services = createServices({ prisma, telegram, scheduler: queues, channel: CHANNEL, bot: { username: 'photobattle_bot' }, logger: silentLogger, env: TEST_ENV });
  await services.settings.ensureDefaults();
  await services.admins.syncOwners([ADMIN_TG_ID]);
  workers = startWorkers(services, { redisUrl: TEST_REDIS_URL, prefix, retryBaseMs: 100, draftTtlHours: 24, duelPostIntervalMs: 100 }, silentLogger);
});

afterEach(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await queues.close();
});

async function addEntry(seed: number) {
  const { user: registered } = await services.users.upsertFromTelegram({ id: 70_000 + seed, first_name: 'Q' });
  const user = await services.users.giveConsent(registered.id);
  const buffer = await makeUniqueJpeg(seed);
  telegram.files.set(`f${seed}`, buffer);
  const draft = await services.photos.createDraft(user, {
    mediaType: 'PHOTO',
    source: 'PHOTO',
    fileId: `f${seed}`,
    fileUniqueId: `u${seed}`,
    contentHash: hashBuffer(buffer),
    mimeType: 'image/jpeg',
    width: 400,
    height: 400,
    fileSize: buffer.length,
  });
  await services.photos.confirm(draft.id, user.id);
}

async function startNow(): Promise<number> {
  const battle = await services.battles.schedule({ title: 'B', startsAt: new Date(Date.now() + 60_000), roundMinutes: 60, tiebreakMinutes: 10, createdById: null });
  await addEntry(1);
  await addEntry(2);
  await prisma.battle.update({ where: { id: battle.id }, data: { startsAt: new Date(Date.now() - 1000) } });
  await queues.triggerTick();
  return battle.id;
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

describe('BullMQ tournament pipeline', () => {
  it('starts the battle on time and prepares the duel post for the admin, retrying temporary Telegram errors', async () => {
    telegram.failNext('sendPhoto', telegramError(502, 'Bad Gateway'), telegramError(429, 'Too Many Requests', 1));
    await startNow();
    const duel = await waitFor(() => prisma.duel.findFirst(), (d) => d?.status === 'READY');
    expect(duel?.preparedFileUniqueId).toBeTruthy();
    const toAdmin = () => telegram.callsOf('sendPhoto').filter((c) => c.chatId === ADMIN_TG_ID);
    expect(toAdmin()).toHaveLength(3);
    expect(telegram.callsOf('sendPhoto').filter((c) => c.chatId === CHANNEL.id)).toHaveLength(0);

    // More ticks must not prepare it again.
    await queues.triggerTick();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(toAdmin()).toHaveLength(3);
  });

  it('debounces vote counter refreshes into channel edits', async () => {
    await startNow();
    const ready = (await waitFor(() => prisma.duel.findFirst(), (d) => d?.status === 'READY'))!;
    await services.battles.linkChannelPost({ messageId: 9000, fileUniqueIds: [ready.preparedFileUniqueId!] });
    const duel = await prisma.duel.findUniqueOrThrow({ where: { id: ready.id } });
    expect(duel.status).toBe('ACTIVE');
    for (let i = 0; i < 5; i += 1) {
      const { user } = await services.users.upsertFromTelegram({ id: 80_000 + i, first_name: 'V' });
      await services.duelVotes.vote(duel.id, 0, 'A', user);
    }
    await waitFor(async () => telegram.callsOf('editMessageReplyMarkup').length, (n) => n >= 1, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const edits = telegram.callsOf('editMessageReplyMarkup');
    expect(edits.length).toBeLessThan(5);
    expect(JSON.stringify(edits.at(-1)?.args[1])).toContain('Поддержать 1 · 5');
  });
});
