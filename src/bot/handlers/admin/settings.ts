import type { Composer } from 'telegraf';
import type { BotSettings } from '../../../generated/prisma/client.js';
import { LIMIT_OPTIONS, PUBLISH_INTERVAL_OPTIONS, type SettingsPatch } from '../../../modules/settings/settings.service.js';
import type { BotContext } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const TOGGLES = {
  mod: 'moderationEnabled',
  vote: 'votingEnabled',
  only: 'submissionsOnlyInBattle',
  weekly: 'weeklyBattlesEnabled',
} as const satisfies Record<string, keyof BotSettings>;

const LIMITS = {
  day: 'maxPhotosPerDay',
  queue: 'maxQueuedPerUser',
  battle: 'maxPhotosPerBattle',
} as const satisfies Record<string, keyof BotSettings>;

type ToggleKey = keyof typeof TOGGLES;
type LimitKey = keyof typeof LIMITS;

async function showSettings(ctx: BotContext): Promise<void> {
  const s = await ctx.deps.services.settings.get();
  const b = ctx.locale.admin.settingsButtons;
  await respond(
    ctx,
    ctx.locale.admin.settingsTitle({
      interval: ctx.locale.admin.intervalLabel(s.publishIntervalMinutes),
      paused: s.publishingPaused,
      moderation: s.moderationEnabled,
      voting: s.votingEnabled,
      maxPerDay: s.maxPhotosPerDay,
      maxQueued: s.maxQueuedPerUser,
      maxPerBattle: s.maxPhotosPerBattle,
      onlyBattle: s.submissionsOnlyInBattle,
      weekly: s.weeklyBattlesEnabled,
    }),
    {
      keyboard: inline([
        [button(b.interval, 'a:set:int')],
        [button(b.moderation, 'a:set:t:mod'), button(b.voting, 'a:set:t:vote')],
        [button(b.maxPerDay, 'a:set:l:day'), button(b.maxQueued, 'a:set:l:queue'), button(b.maxPerBattle, 'a:set:l:battle')],
        [button(b.onlyBattle, 'a:set:t:only'), button(b.weekly, 'a:set:t:weekly')],
        [button(ctx.locale.admin.buttons.panel, PANEL)],
      ]),
    },
  );
}

async function save(ctx: BotContext, patch: SettingsPatch): Promise<void> {
  await ctx.deps.services.settings.update(patch, adminUserId(ctx));
  await answer(ctx, ctx.locale.admin.settingsSaved);
  await showSettings(ctx);
}

export function registerSettingsHandlers(admin: Composer<BotContext>): void {
  admin.action('a:set', async (ctx) => {
    await answer(ctx);
    await showSettings(ctx);
  });

  admin.action('a:set:int', async (ctx) => {
    await answer(ctx);
    const options = PUBLISH_INTERVAL_OPTIONS.map((minutes) =>
      button(minutes === 0 ? ctx.locale.admin.intervalManual : ctx.locale.admin.intervalLabel(minutes), `a:set:int:${minutes}`),
    );
    const rows = [];
    for (let i = 0; i < options.length; i += 2) rows.push(options.slice(i, i + 2));
    rows.push([button(ctx.locale.common.back, 'a:set')]);
    await respond(ctx, ctx.locale.admin.chooseInterval, { keyboard: inline(rows) });
  });

  admin.action(/^a:set:int:(\d+)$/, async (ctx) => {
    const minutes = matchInt(ctx);
    if (!(PUBLISH_INTERVAL_OPTIONS as readonly number[]).includes(minutes)) return answer(ctx);
    await save(ctx, { publishIntervalMinutes: minutes });
  });

  admin.action(/^a:set:t:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    if (!(key in TOGGLES)) return answer(ctx);
    const field = TOGGLES[key as ToggleKey];
    const current = await ctx.deps.services.settings.get();
    await save(ctx, { [field]: !current[field] });
  });

  admin.action(/^a:set:l:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    if (!(key in LIMITS)) return answer(ctx);
    await answer(ctx);
    const label = ctx.locale.admin.settingsButtons[({ day: 'maxPerDay', queue: 'maxQueued', battle: 'maxPerBattle' } as const)[key as LimitKey]];
    const options = LIMIT_OPTIONS.map((value) => button(String(value), `a:set:l:${key}:${value}`));
    await respond(ctx, ctx.locale.admin.chooseLimit(label), {
      keyboard: inline([options.slice(0, 4), options.slice(4), [button(ctx.locale.common.back, 'a:set')]]),
    });
  });

  admin.action(/^a:set:l:(\w+):(\d+)$/, async (ctx) => {
    const key = matchString(ctx);
    const value = matchInt(ctx, 2);
    if (!(key in LIMITS) || !(LIMIT_OPTIONS as readonly number[]).includes(value)) return answer(ctx);
    await save(ctx, { [LIMITS[key as LimitKey]]: value });
  });
}
