import { Queue, type JobsOptions } from 'bullmq';
import { bullConnection } from '../lib/redis.js';
import type { JobScheduler } from '../modules/contracts.js';

export const QUEUE_NAMES = {
  duels: 'duel-prepare',
  votes: 'vote-refresh',
  broadcasts: 'broadcasts',
  maintenance: 'maintenance',
} as const;

export const JOB_NAMES = {
  prepareDuel: 'prepare-duel',
  refreshVotes: 'refresh-votes',
  broadcast: 'broadcast',
  tick: 'tick',
} as const;

export const CUSTOM_BACKOFF = 'telegram';
const VOTE_REFRESH_DEBOUNCE_MS = 2_000;
const TICK_EVERY_MS = 30_000;

export interface DuelJobData {
  duelId: number;
  stage: number;
}
export interface VoteRefreshJobData {
  duelId: number;
}
export interface BroadcastJobData {
  broadcastId: number;
}

export interface QueueOptions {
  redisUrl: string;
  prefix: string;
  postMaxAttempts: number;
}

const cleanup: JobsOptions = { removeOnComplete: true, removeOnFail: { count: 200 } };
/** Jobs with deterministic ids must not linger after failure, or re-adding them would be ignored. */
const cleanupAll: JobsOptions = { removeOnComplete: true, removeOnFail: true };

export class AppQueues implements JobScheduler {
  readonly duels: Queue;
  readonly votes: Queue;
  readonly broadcasts: Queue;
  readonly maintenance: Queue;

  constructor(private readonly options: QueueOptions) {
    const base = { connection: bullConnection(options.redisUrl), prefix: options.prefix };
    this.duels = new Queue(QUEUE_NAMES.duels, base);
    this.votes = new Queue(QUEUE_NAMES.votes, base);
    this.broadcasts = new Queue(QUEUE_NAMES.broadcasts, base);
    this.maintenance = new Queue(QUEUE_NAMES.maintenance, base);
  }

  /** Registers the recurring tournament tick. Idempotent. */
  async registerSchedules(): Promise<void> {
    await this.maintenance.upsertJobScheduler('tick', { every: TICK_EVERY_MS }, { name: JOB_NAMES.tick, opts: cleanup });
  }

  async enqueueDuelPrepare(duelId: number, stage: number): Promise<void> {
    const data: DuelJobData = { duelId, stage };
    await this.duels.add(JOB_NAMES.prepareDuel, data, {
      ...cleanupAll,
      jobId: `duel-${duelId}-${stage}`, // one prepared post per duel stage, however often the tick re-adds it
      attempts: this.options.postMaxAttempts,
      backoff: { type: CUSTOM_BACKOFF },
    });
  }

  async triggerTick(): Promise<void> {
    // While a "tick-now" job is waiting, further triggers are merged into it.
    await this.maintenance.add(JOB_NAMES.tick, {}, { ...cleanupAll, jobId: 'tick-now' });
  }

  async scheduleTickAt(at: Date, key: string): Promise<void> {
    // The 30-second tick is the safety net; this makes starts and duel ends happen on time.
    const delay = Math.max(0, at.getTime() - Date.now()) + 500;
    await this.maintenance.add(JOB_NAMES.tick, {}, { ...cleanupAll, jobId: `tick-at-${key}`, delay });
  }

  async scheduleVoteRefresh(duelId: number): Promise<void> {
    const data: VoteRefreshJobData = { duelId };
    // One refresh per duel per debounce window; bursts of votes collapse into a single edit.
    const bucket = Math.floor(Date.now() / VOTE_REFRESH_DEBOUNCE_MS);
    await this.votes.add(JOB_NAMES.refreshVotes, data, {
      ...cleanup,
      jobId: `votes-${duelId}-${bucket}`,
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
    await Promise.all([this.duels.close(), this.votes.close(), this.broadcasts.close(), this.maintenance.close()]);
  }
}
