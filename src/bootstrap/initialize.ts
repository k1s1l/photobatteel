import type { Services } from '../services.js';

/**
 * Idempotent first-run setup: default settings row and owners from ADMIN_IDS.
 * Executed on every start and by `npm run db:seed`.
 */
export async function initializeDatabase(services: Pick<Services, 'settings' | 'admins'>, adminIds: readonly number[]): Promise<void> {
  await services.settings.ensureDefaults();
  await services.admins.syncOwners(adminIds);
}
