/**
 * Initial database setup: creates the settings row and admin owners from ADMIN_IDS.
 * The application performs the same idempotent setup on every start.
 */
import 'dotenv/config';
import { initializeDatabase } from '../src/bootstrap/initialize.js';
import { createLogger } from '../src/lib/logger.js';
import { createPrisma } from '../src/lib/prisma.js';
import { ActivityService } from '../src/modules/activity/activity.service.js';
import { AdminService } from '../src/modules/admins/admin.service.js';
import { DEFAULT_PACKAGES } from '../src/modules/payments/payment.service.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const adminIds = (process.env.ADMIN_IDS ?? '')
  .split(/[\s,;]+/)
  .filter(Boolean)
  .map((id) => {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid id in ADMIN_IDS: ${id}`);
    return Number(id);
  });

const logger = createLogger('info', false);
const prisma = createPrisma(databaseUrl);
const activity = new ActivityService(prisma, logger);

try {
  await initializeDatabase(
    { settings: new SettingsService(prisma, activity), admins: new AdminService(prisma, activity, logger) },
    adminIds,
  );
  if ((await prisma.votePackage.count()) === 0) await prisma.votePackage.createMany({ data: DEFAULT_PACKAGES.map((pack) => ({ ...pack })) });
  logger.info({ admins: adminIds.length }, 'Database initialized');
} finally {
  await prisma.$disconnect();
}
