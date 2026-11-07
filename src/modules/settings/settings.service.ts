import type { BotSettings, PrismaClient } from '../../generated/prisma/client.js';
import type { ActivityService } from '../activity/activity.service.js';
import { stageTemplateId, stageTemplates, type StagedKey, type StageVariant } from '../duels/templates.js';

export type SettingsPatch = Partial<
  Pick<
    BotSettings,
    | 'moderationEnabled'
    | 'subscribersOnly'
    | 'paidVotesEnabled'
    | 'maxPhotosPerBattle'
    | 'duelTemplate'
    | 'announceTemplate'
    | 'roundTemplate'
    | 'winnerTemplate'
    | 'buttonsTemplate'
    | 'transferEnabled'
    | 'transferDetails'
    | 'monobankAccountId'
  >
>;

export const LIMIT_OPTIONS = [0, 1, 2, 3, 5] as const;
/** Telegram caption limit is 1024 visible characters; the template leaves room for placeholders. */
export const MAX_TEMPLATE_LENGTH = 4000;

const TEMPLATE_PATCH_KEYS = ['duelTemplate', 'announceTemplate', 'roundTemplate', 'winnerTemplate', 'buttonsTemplate'] as const;
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
    const templates = TEMPLATE_PATCH_KEYS.filter((key) => patch[key] !== undefined);
    if (templates.some((key) => (patch[key]?.length ?? 0) > MAX_TEMPLATE_LENGTH)) throw new RangeError('Template is too long');
    const updated = await this.prisma.botSettings.update({ where: { id: SETTINGS_ID }, data: { ...patch, updatedById: actorUserId } });
    this.cache = { value: updated, expiresAt: Date.now() + CACHE_TTL_MS };
    // Template bodies are not copied into the audit log, only which one changed.
    const details = templates.length > 0 ? { templates: templates.map((key) => `${key}${patch[key] === null ? ':reset' : ''}`) } : { ...patch };
    await this.activity.log({ action: templates.length > 0 ? 'TEMPLATE_UPDATED' : 'SETTINGS_UPDATED', userId: actorUserId, details });
    return updated;
  }

  /** Saves (or with null removes) the design of one template for one round. */
  async setStageTemplate(key: StagedKey, variant: StageVariant, html: string | null, actorUserId: number | null): Promise<BotSettings> {
    if (html !== null && html.length > MAX_TEMPLATE_LENGTH) throw new RangeError('Template is too long');
    const id = stageTemplateId(key, variant);
    const next = { ...stageTemplates(await this.ensureDefaults()) };
    if (html === null) delete next[id];
    else next[id] = html;
    const updated = await this.prisma.botSettings.update({ where: { id: SETTINGS_ID }, data: { stageTemplates: next, updatedById: actorUserId } });
    this.cache = { value: updated, expiresAt: Date.now() + CACHE_TTL_MS };
    await this.activity.log({ action: 'TEMPLATE_UPDATED', userId: actorUserId, details: { templates: [`${id}${html === null ? ':reset' : ''}`] } });
    return updated;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}
