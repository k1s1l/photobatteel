import type { Broadcast, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Logger } from '../../lib/logger.js';
import { classifyTelegramError } from '../../lib/telegram-errors.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { JobScheduler, TelegramGateway } from '../contracts.js';
import type { NotificationService } from '../notifications/notification.service.js';

const BATCH_SIZE = 100;
const MAX_RATE_LIMIT_RETRIES = 3;

const recipientsWhere = (afterUserId: number): Prisma.UserWhereInput => ({
  id: { gt: afterUserId },
  isBlocked: false,
  botBlockedAt: null,
});

/**
 * Announcements to all users. The admin's message is copied (formatting and
 * media preserved). Progress is checkpointed so a restarted job resumes.
 */
export class BroadcastService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TelegramGateway,
    private readonly scheduler: JobScheduler,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
    private readonly ratePerSecond: number,
  ) {}

  async countRecipients(): Promise<number> {
    return this.prisma.user.count({ where: recipientsWhere(0) });
  }

  async create(adminUserId: number, fromChatId: number, messageId: number): Promise<{ broadcast: Broadcast; recipients: number }> {
    const broadcast = await this.prisma.broadcast.create({ data: { createdById: adminUserId, fromChatId: BigInt(fromChatId), messageId } });
    await this.activity.log({ action: 'BROADCAST_CREATED', userId: adminUserId, entityType: 'Broadcast', entityId: broadcast.id });
    const recipients = await this.countRecipients();
    await this.scheduler.enqueueBroadcast(broadcast.id);
    return { broadcast, recipients };
  }

  async process(broadcastId: number, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<Broadcast> {
    const broadcast = await this.prisma.broadcast.findUniqueOrThrow({ where: { id: broadcastId }, include: { createdBy: true } });
    if (broadcast.status === 'DONE') return broadcast;
    await this.prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'RUNNING' } });

    const delayMs = Math.ceil(1000 / this.ratePerSecond);
    let cursor = broadcast.lastUserId;
    let sent = broadcast.sentCount;
    let failed = broadcast.failedCount;

    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: recipientsWhere(cursor),
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        select: { id: true, telegramId: true },
      });
      if (batch.length === 0) break;

      for (const recipient of batch) {
        const delivered = await this.deliver(Number(recipient.telegramId), broadcast.fromChatId, broadcast.messageId, sleep);
        if (delivered) sent += 1;
        else failed += 1;
        cursor = recipient.id;
        await sleep(delayMs);
      }
      await this.prisma.broadcast.update({ where: { id: broadcastId }, data: { lastUserId: cursor, sentCount: sent, failedCount: failed } });
    }

    const finished = await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'DONE', finishedAt: new Date(), lastUserId: cursor, sentCount: sent, failedCount: failed },
    });
    await this.activity.log({
      action: 'BROADCAST_FINISHED',
      userId: broadcast.createdById,
      entityType: 'Broadcast',
      entityId: broadcastId,
      details: { sent, failed },
    });
    await this.notifications.notifyUser(broadcast.createdBy, (l) => l.admin.broadcastDone({ sent, failed }));
    return finished;
  }

  async markFailed(broadcastId: number): Promise<void> {
    await this.prisma.broadcast.update({ where: { id: broadcastId }, data: { status: 'FAILED' } });
  }

  private async deliver(chatId: number, fromChatId: bigint, messageId: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      try {
        await this.telegram.copyMessage(chatId, Number(fromChatId), messageId);
        return true;
      } catch (error) {
        const classified = classifyTelegramError(error);
        if (classified.kind === 'rate_limited') {
          await sleep(classified.retryAfterMs ?? 1000);
          continue;
        }
        if (classified.kind === 'bot_blocked') {
          await this.prisma.user.updateMany({ where: { telegramId: BigInt(chatId) }, data: { botBlockedAt: new Date() } });
        } else {
          this.logger.warn({ chatId, error: classified.description }, 'Broadcast delivery failed');
        }
        return false;
      }
    }
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
