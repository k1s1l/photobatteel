import type { Redis } from 'ioredis';
import type { AsyncSessionStore } from 'telegraf/session';
import type { SessionData } from './context.js';

const TTL_SECONDS = 24 * 60 * 60;

/** Redis-backed Telegraf session store: survives restarts and works with several instances. */
export class RedisSessionStore implements AsyncSessionStore<SessionData> {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'session:',
  ) {}

  async get(key: string): Promise<SessionData | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: SessionData): Promise<void> {
    if (!value.state) {
      await this.redis.del(this.prefix + key);
      return;
    }
    await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', TTL_SECONDS);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
