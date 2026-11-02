import { Redis } from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

/** BullMQ connection options: every queue/worker gets its own connection. */
export function bullConnection(url: string) {
  return { url, maxRetriesPerRequest: null } as const;
}

export type { Redis };
