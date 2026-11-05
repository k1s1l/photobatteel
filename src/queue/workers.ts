import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Logger } from '../lib/logger.js';
import { bullConnection } from '../lib/redis.js';
import { classifyTelegramError, isRetryable } from '../lib/telegram-errors.js';
import type { Services } from '../services.js';
import { QUEUE_NAMES, type BroadcastJobData, type DuelPostJobData, type VoteRefreshJobData } from './queues.js';
import { RetryLaterError, telegramBackoff } from './retry.js';

export interface WorkerOptions {
  redisUrl: string;
  prefix: string;
  retryBaseMs: number;
  draftTtlHours: number;
  duelPostIntervalMs: number;
}

/**
 * Background workers. Duel posts run one at a time with a pause between them
 * (Telegram limits posts per channel); the tournament tick runs every 30 s.
 */
export function startWorkers(services: Services, options: WorkerOptions, logger: Logger): Worker[] {
  const base = { connection: bullConnection(options.redisUrl), prefix: options.prefix };
  const backoffStrategy = telegramBackoff(options.retryBaseMs);

  const duels = new Worker(
    QUEUE_NAMES.duels,
    async (job: Job<DuelPostJobData>) => {
      try {
        return await services.battles.postDuel(job.data.duelId, job.data.stage);
      } catch (error) {
        const classified = classifyTelegramError(error);
        if (!isRetryable(classified)) throw new UnrecoverableError(classified.description);
        throw new RetryLaterError(classified.description, classified.retryAfterMs);
      }
    },
    { ...base, concurrency: 1, limiter: { max: 1, duration: options.duelPostIntervalMs }, settings: { backoffStrategy } },
  );

  const votes = new Worker(
    QUEUE_NAMES.votes,
    async (job: Job<VoteRefreshJobData>) => services.battles.refreshButtons(job.data.duelId),
    // Channel message edits are rate limited by Telegram; stay well below the limit.
    { ...base, concurrency: 1, limiter: { max: 15, duration: 10_000 }, settings: { backoffStrategy } },
  );

  const broadcasts = new Worker(
    QUEUE_NAMES.broadcasts,
    async (job: Job<BroadcastJobData>) => {
      const result = await services.broadcasts.process(job.data.broadcastId);
      return { sent: result.sentCount, failed: result.failedCount };
    },
    { ...base, concurrency: 1, lockDuration: 120_000 },
  );

  const maintenance = new Worker(
    QUEUE_NAMES.maintenance,
    async () => {
      await services.battles.tick();
      return { expiredDrafts: await services.photos.expireDrafts(options.draftTtlHours) };
    },
    { ...base, concurrency: 1 },
  );

  const workers = [duels, votes, broadcasts, maintenance];
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      logger.warn({ queue: worker.name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err }, 'Job failed');
      if (worker === broadcasts && job && (job.attemptsMade >= (job.opts.attempts ?? 1) || job.finishedOn !== undefined)) {
        void services.broadcasts.markFailed((job.data as BroadcastJobData).broadcastId).catch(() => undefined);
      }
    });
    worker.on('error', (err) => logger.error({ queue: worker.name, err }, 'Worker error'));
  }
  return workers;
}
