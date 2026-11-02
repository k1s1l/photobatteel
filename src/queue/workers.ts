import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Logger } from '../lib/logger.js';
import { bullConnection } from '../lib/redis.js';
import type { Services } from '../services.js';
import { PublicationRecordError } from '../modules/publications/publication.service.js';
import { JOB_NAMES, QUEUE_NAMES, type BroadcastJobData, type PublishJobData, type VoteRefreshJobData } from './queues.js';
import { RetryLaterError, telegramBackoff } from './retry.js';

export interface WorkerOptions {
  redisUrl: string;
  prefix: string;
  retryBaseMs: number;
  draftTtlHours: number;
}

/**
 * Starts all background workers. The publication worker has concurrency 1:
 * ticks and publish jobs run strictly one at a time, which keeps the order.
 */
export function startWorkers(services: Services, options: WorkerOptions, logger: Logger): Worker[] {
  const base = { connection: bullConnection(options.redisUrl), prefix: options.prefix };
  const backoffStrategy = telegramBackoff(options.retryBaseMs);

  const publications = new Worker(
    QUEUE_NAMES.publications,
    async (job: Job) => {
      if (job.name === JOB_NAMES.publishTick) {
        const result = await services.publications.tick();
        if (result === 'claimed') logger.debug('Publication tick claimed the next photo');
        return result;
      }
      if (job.name === JOB_NAMES.publish) return processPublishJob(services, job as Job<PublishJobData>);
      throw new UnrecoverableError(`Unknown job ${job.name}`);
    },
    { ...base, concurrency: 1, settings: { backoffStrategy } },
  );

  const votes = new Worker(
    QUEUE_NAMES.votes,
    async (job: Job<VoteRefreshJobData>) => services.votes.refreshButton(job.data.photoId),
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
    async (job: Job) => {
      if (job.name === JOB_NAMES.weeklyBattle) {
        const battle = await services.battles.createWeeklyIfEnabled();
        return battle ? { createdBattleId: battle.id } : { skipped: true };
      }
      await services.battles.tick();
      const expired = await services.photos.expireDrafts(options.draftTtlHours);
      return { expiredDrafts: expired };
    },
    { ...base, concurrency: 1 },
  );

  const workers = [publications, votes, broadcasts, maintenance];
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      logger.warn({ queue: worker.name, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err }, 'Job failed');
      if (worker === publications && job?.name === JOB_NAMES.publish && isFinalAttempt(job)) {
        void services.publications.markFailed((job.data as PublishJobData).queueItemId, err.message).catch((error: unknown) =>
          logger.error({ err: error }, 'Failed to mark publication as failed'),
        );
      }
      if (worker === broadcasts && job && isFinalAttempt(job)) {
        void services.broadcasts.markFailed((job.data as BroadcastJobData).broadcastId).catch(() => undefined);
      }
    });
    worker.on('error', (err) => logger.error({ queue: worker.name, err }, 'Worker error'));
  }
  return workers;
}

async function processPublishJob(services: Services, job: Job<PublishJobData>) {
  let outcome;
  try {
    outcome = await services.publications.processItem(job.data.queueItemId);
  } catch (error) {
    // The post exists but was not recorded: retrying would publish it twice.
    if (error instanceof PublicationRecordError) throw new UnrecoverableError(error.message);
    throw error;
  }
  if (outcome.status === 'retry') throw new RetryLaterError(outcome.error, outcome.retryAfterMs);
  return outcome;
}

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1) || job.finishedOn !== undefined;
}
