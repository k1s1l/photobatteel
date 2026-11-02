import type { PrismaClient } from '../../generated/prisma/client.js';
import { DomainError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import type { ActivityService } from '../activity/activity.service.js';

const CACHE_TTL_MS = 30_000;

/**
 * Admin rights are stored in the Admin table. Owners come from ADMIN_IDS and
 * are synchronised on every start; access checks always hit the server-side
 * table (with a short cache), never client-supplied data.
 */
export class AdminService {
  private cache: { ids: Set<string>; expiresAt: number } | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
    private readonly logger: Logger,
  ) {}

  async syncOwners(ownerTelegramIds: readonly number[]): Promise<void> {
    const ids = ownerTelegramIds.map((id) => BigInt(id));
    await this.prisma.$transaction(async (tx) => {
      for (const telegramId of ids) {
        const user = await tx.user.findUnique({ where: { telegramId }, select: { id: true } });
        await tx.admin.upsert({
          where: { telegramId },
          create: { telegramId, role: 'OWNER', isActive: true, userId: user?.id ?? null },
          update: { role: 'OWNER', isActive: true, ...(user ? { userId: user.id } : {}) },
        });
      }
      // Owners removed from ADMIN_IDS lose their rights.
      await tx.admin.updateMany({ where: { role: 'OWNER', telegramId: { notIn: ids } }, data: { isActive: false } });
    });
    this.cache = undefined;
    if (ids.length === 0) this.logger.warn('ADMIN_IDS is empty: nobody can access the admin panel');
  }

  /** Links an admin record to the user profile once the admin talks to the bot. */
  async linkUser(telegramId: number, userId: number): Promise<void> {
    await this.prisma.admin.updateMany({ where: { telegramId: BigInt(telegramId), userId: null }, data: { userId } });
  }

  async isAdmin(telegramId: number): Promise<boolean> {
    const ids = await this.activeIds();
    return ids.has(String(telegramId));
  }

  /** Throws FORBIDDEN and records the attempt when the user is not an admin. */
  async assertAdmin(telegramId: number): Promise<void> {
    if (await this.isAdmin(telegramId)) return;
    await this.activity.log({ action: 'ADMIN_ACCESS_DENIED', telegramId });
    throw new DomainError('FORBIDDEN');
  }

  async listAdminTelegramIds(): Promise<number[]> {
    return [...(await this.activeIds())].map(Number);
  }

  private async activeIds(): Promise<Set<string>> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.ids;
    const admins = await this.prisma.admin.findMany({ where: { isActive: true }, select: { telegramId: true } });
    const ids = new Set(admins.map((admin) => admin.telegramId.toString()));
    this.cache = { ids, expiresAt: Date.now() + CACHE_TTL_MS };
    return ids;
  }
}
