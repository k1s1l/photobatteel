import type { ActivityAction, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../lib/logger.js';

export interface ActivityEntry {
  action: ActivityAction;
  userId?: number | null;
  telegramId?: number | bigint | null;
  entityType?: string;
  entityId?: string | number;
  details?: Prisma.InputJsonValue;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Audit trail of user and admin actions. Logging never breaks the main flow. */
export class ActivityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async log(entry: ActivityEntry, db: Db = this.prisma): Promise<void> {
    try {
      await db.activityLog.create({
        data: {
          action: entry.action,
          userId: entry.userId ?? null,
          telegramId: entry.telegramId == null ? null : BigInt(entry.telegramId),
          entityType: entry.entityType ?? null,
          entityId: entry.entityId == null ? null : String(entry.entityId),
          ...(entry.details === undefined ? {} : { details: entry.details }),
        },
      });
    } catch (error) {
      if (db !== this.prisma) throw error; // inside a transaction the caller must know
      this.logger.warn({ err: error, action: entry.action }, 'Failed to write activity log');
    }
    this.logger.info({ action: entry.action, userId: entry.userId, entity: entry.entityType, entityId: entry.entityId }, 'activity');
  }
}
