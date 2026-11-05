import type { BotSettings, PrismaClient } from '../../generated/prisma/client.js';
import type { ActivityService } from '../activity/activity.service.js';

export type SettingsPatch = Partial<
  Pick<BotSettings, 'moderationEnabled' | 'subscribersOnly' | 'paidVotesEnabled' | 'maxPhotosPerBattle' | 'duelTemplate'>
>;

export const LIMIT_OPTIONS = [0, 1, 2, 3, 5] as const;
/** Telegram caption limit is 1024 visible characters; the template leaves room for placeholders. */
export const MAX_TEMPLATE_LENGTH = 4000;

const SETTINGS_ID = 1;
const CACHE_TTL_MS = 5_000;

export class SettingsService {
  private cache: { value: BotSettings; expiresAt: number } | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
  ) {}

  /** Creates the singleton settings row if it does not exist. */
  async ensureDefaults(): Promise<BotSettings> {
    const settings = await this.prisma.botSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID }, update: {} });
    this.cache = { value: settings, expiresAt: Date.now() + CACHE_TTL_MS };
    return settings;
  }

  async get(): Promise<BotSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    const settings = await this.prisma.botSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings) return this.ensureDefaults();
    this.cache = { value: settings, expiresAt: Date.now() + CACHE_TTL_MS };
    return settings;
  }

  async update(patch: SettingsPatch, actorUserId: number | null): Promise<BotSettings> {
    if (patch.maxPhotosPerBattle !== undefined && (!Number.isInteger(patch.maxPhotosPerBattle) || patch.maxPhotosPerBattle < 0 || patch.maxPhotosPerBattle > 100)) {
      throw new RangeError('Invalid maxPhotosPerBattle');
    }
    if (patch.duelTemplate && patch.duelTemplate.length > MAX_TEMPLATE_LENGTH) throw new RangeError('Template is too long');
    const updated = await this.prisma.botSettings.update({ where: { id: SETTINGS_ID }, data: { ...patch, updatedById: actorUserId } });
    this.cache = { value: updated, expiresAt: Date.now() + CACHE_TTL_MS };
    const action = patch.duelTemplate !== undefined ? 'TEMPLATE_UPDATED' : 'SETTINGS_UPDATED';
    await this.activity.log({ action, userId: actorUserId, details: patch.duelTemplate !== undefined ? { reset: patch.duelTemplate === null } : { ...patch } });
    return updated;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
