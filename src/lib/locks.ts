import type { Redis } from 'ioredis';

/**
 * Short-lived Redis locks used to make button presses and uploads idempotent
 * across concurrent updates and across bot instances.
 */
export class LockService {
  constructor(private readonly redis: Redis) {}

  /** Returns true when the lock was acquired. */
  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(`lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.redis.del(`lock:${key}`);
  }

  /** Runs `fn` only if the lock is free; returns `undefined` when it is held by someone else. */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.acquire(key, ttlMs))) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(key);
    }
  }
}
