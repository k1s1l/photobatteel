import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from '../lib/redis.js';
import type { JobScheduler } from '../modules/contracts.js';

export const QUEUE_NAMES = {
  publications: 'publications',
  votes: 'vote-refresh',
  broadcasts: 'broadcasts',
  maintenance: 'maintenance',
} as const;

export const JOB_NAMES = {
  publish: 'publish',
  publishTick: 'publish-tick',
  refreshVotes: 'refresh-votes',
  broadcast: 'broadcast',
  maintenanceTick: 'maintenance-tick',
  weeklyBattle: 'weekly-battle',
} as const;

export const CUSTOM_BACKOFF = 'telegram';
const VOTE_REFRESH_DEBOUNCE_MS = 2_000;
const TICK_EVERY_MS = 60_000;

export interface PublishJobData {
  queueItemId: number;
}
export interface VoteRefreshJobData {
  photoId: number;
}
export interface BroadcastJobData {
  broadcastId: number;
}

export interface QueueOptions {
  redisUrl: string;
  prefix: string;
  publishMaxAttempts: number;
  timeZone: string;
}

export class AppQueues implements JobScheduler {
  readonly publications: Queue;
  readonly votes: Queue;
  readonly broadcasts: Queue;
  readonly maintenance: Queue;

  constructor(private readonly options: QueueOptions) {
    const base = { connection: bullConnection(options.redisUrl), prefix: options.prefix };
    this.publications = new Queue(QUEUE_NAMES.publications, base);
    this.votes = new Queue(QUEUE_NAMES.votes, base);
    this.broadcasts = new Queue(QUEUE_NAMES.broadcasts, base);
    this.maintenance = new Queue(QUEUE_NAMES.maintenance, base);
  }

  /** Registers recurring jobs. Idempotent: safe to call on every start and from several instances. */
  async registerSchedules(): Promise<void> {
    await this.publications.upsertJobScheduler('publish-tick', { every: TICK_EVERY_MS }, { name: JOB_NAMES.publishTick, opts: cleanup });
    await this.maintenance.upsertJobScheduler('maintenance-tick', { every: TICK_EVERY_MS }, { name: JOB_NAMES.maintenanceTick, opts: cleanup });
    await this.maintenance.upsertJobScheduler(
      'weekly-battle',
      { pattern: '0 10 * * 1', tz: this.options.timeZone },
      { name: JOB_NAMES.weeklyBattle, opts: cleanup },
    );
  }

  async enqueuePublication(queueItemId: number): Promise<void> {
    const data: PublishJobData = { queueItemId };
    await this.publications.add(JOB_NAMES.publish, data, {
      ...cleanupAll,
      jobId: `publish-${queueItemId}`, // deterministic: re-adding an existing job is a no-op
      attempts: this.options.publishMaxAttempts,
      backoff: { type: CUSTOM_BACKOFF },
    });
  }

  async triggerPublishTick(): Promise<void> {
    // While a "tick-now" job is waiting, further triggers are merged into it.
    await this.publications.add(JOB_NAMES.publishTick, {}, { ...cleanupAll, jobId: 'publish-tick-now' });
  }

  async scheduleVoteRefresh(photoId: number): Promise<void> {
    const data: VoteRefreshJobData = { photoId };
    // One refresh per photo per debounce window; bursts of votes collapse into a single edit.
    const bucket = Math.floor(Date.now() / VOTE_REFRESH_DEBOUNCE_MS);
    await this.votes.add(JOB_NAMES.refreshVotes, data, {
      ...cleanup,
      jobId: `votes-${photoId}-${bucket}`,
      delay: VOTE_REFRESH_DEBOUNCE_MS,
      attempts: 5,
      backoff: { type: CUSTOM_BACKOFF },
    });
  }

  async enqueueBroadcast(broadcastId: number): Promise<void> {
    const data: BroadcastJobData = { broadcastId };
    await this.broadcasts.add(JOB_NAMES.broadcast, data, {
      ...cleanup,
      jobId: `broadcast-${broadcastId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    });
  }

  async close(): Promise<void> {
    await Promise.all([this.publications.close(), this.votes.close(), this.broadcasts.close(), this.maintenance.close()]);
  }
}

const cleanup: JobsOptions = { removeOnComplete: true, removeOnFail: { count: 200 } };
/** Jobs with deterministic ids must not linger after failure, or re-adding them would be ignored. */
const cleanupAll: JobsOptions = { removeOnComplete: true, removeOnFail: true };
