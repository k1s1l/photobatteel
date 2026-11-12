import type { Admin, PrismaClient, User } from '../../generated/prisma/client.js';
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

  /** Owners (from ADMIN_IDS) manage the other admins. */
  async isOwner(telegramId: number): Promise<boolean> {
    const admin = await this.prisma.admin.findUnique({ where: { telegramId: BigInt(telegramId) } });
    return admin?.isActive === true && admin.role === 'OWNER';
  }

  /** Active admins with their profiles (when they have talked to the bot). */
  async list(): Promise<(Admin & { user: User | null })[]> {
    return this.prisma.admin.findMany({ where: { isActive: true }, include: { user: true }, orderBy: [{ role: 'desc' }, { id: 'asc' }] });
  }

  /** Gives admin rights by Telegram id; the person may not have opened the bot yet. */
  async add(telegramId: number, actorUserId: number | null): Promise<Admin> {
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new DomainError('NOT_FOUND');
    const id = BigInt(telegramId);
    const user = await this.prisma.user.findUnique({ where: { telegramId: id }, select: { id: true } });
    const existing = await this.prisma.admin.findUnique({ where: { telegramId: id } });
    const admin = existing
      ? await this.prisma.admin.update({ where: { id: existing.id }, data: { isActive: true, ...(user ? { userId: user.id } : {}) } })
      : await this.prisma.admin.create({ data: { telegramId: id, role: 'ADMIN', isActive: true, userId: user?.id ?? null } });
    this.cache = undefined;
    await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Admin', entityId: admin.id, details: { added: telegramId } });
    return admin;
  }

  /** Takes admin rights away. Owners from ADMIN_IDS can only be removed in Railway. */
  async remove(adminId: number, actorUserId: number | null): Promise<boolean> {
    const admin = await this.prisma.admin.findUnique({ where: { id: adminId } });
    if (!admin?.isActive || admin.role === 'OWNER') return false;
    await this.prisma.admin.update({ where: { id: adminId }, data: { isActive: false } });
    this.cache = undefined;
    await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, entityType: 'Admin', entityId: adminId, details: { removed: admin.telegramId.toString() } });
    return true;
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
