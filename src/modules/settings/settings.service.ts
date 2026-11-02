import type { BotSettings, PrismaClient } from '../../generated/prisma/client.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { JobScheduler } from '../contracts.js';

export type SettingsPatch = Partial<
  Pick<
    BotSettings,
    | 'publishingPaused'
    | 'publishIntervalMinutes'
    | 'moderationEnabled'
    | 'votingEnabled'
    | 'maxPhotosPerDay'
    | 'maxQueuedPerUser'
    | 'maxPhotosPerBattle'
    | 'submissionsOnlyInBattle'
    | 'weeklyBattlesEnabled'
  >
>;

export const PUBLISH_INTERVAL_OPTIONS = [0, 5, 15, 30, 60, 180, 360] as const;
export const LIMIT_OPTIONS = [0, 1, 2, 3, 5, 10, 20] as const;

const SETTINGS_ID = 1;
const CACHE_TTL_MS = 5_000;

export class SettingsService {
  private cache: { value: BotSettings; expiresAt: number } | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly activity: ActivityService,
    private readonly scheduler: JobScheduler,
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
    validatePatch(patch);
    const before = await this.get();
    const updated = await this.prisma.botSettings.update({
      where: { id: SETTINGS_ID },
      data: { ...patch, updatedById: actorUserId },
    });
    this.cache = { value: updated, expiresAt: Date.now() + CACHE_TTL_MS };

    if (patch.publishingPaused !== undefined && patch.publishingPaused !== before.publishingPaused) {
      await this.activity.log({ action: updated.publishingPaused ? 'PUBLISHING_PAUSED' : 'PUBLISHING_RESUMED', userId: actorUserId });
    } else {
      await this.activity.log({ action: 'SETTINGS_UPDATED', userId: actorUserId, details: { ...patch } });
    }
    const resumed = patch.publishingPaused === false && before.publishingPaused;
    const intervalChanged = patch.publishIntervalMinutes !== undefined && patch.publishIntervalMinutes !== before.publishIntervalMinutes;
    if (resumed || intervalChanged) await this.scheduler.triggerPublishTick();
    return updated;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

function validatePatch(patch: SettingsPatch): void {
  const nonNegativeInts: (keyof SettingsPatch)[] = ['publishIntervalMinutes', 'maxPhotosPerDay', 'maxQueuedPerUser', 'maxPhotosPerBattle'];
  for (const key of nonNegativeInts) {
    const value = patch[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 10_080)) {
      throw new RangeError(`Invalid value for ${key}`);
    }
  }
}
