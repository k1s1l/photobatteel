import type { Composer } from 'telegraf';
import { LIMIT_OPTIONS, type SettingsPatch } from '../../../modules/settings/settings.service.js';
import type { BotContext } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const TOGGLES = { mod: 'moderationEnabled', subs: 'subscribersOnly', auto: 'autoPublish' } as const;
type ToggleKey = keyof typeof TOGGLES;

async function showSettings(ctx: BotContext): Promise<void> {
  const s = await ctx.deps.services.settings.get();
  const b = ctx.locale.admin.settingsButtons;
  await respond(ctx, ctx.locale.admin.settingsTitle({ moderation: s.moderationEnabled, subscribersOnly: s.subscribersOnly, maxPerBattle: s.maxPhotosPerBattle, autoPublish: s.autoPublish }), {
    keyboard: inline([
      [button(b.moderation, 'a:set:t:mod'), button(b.subscribersOnly, 'a:set:t:subs')],
      [button(b.maxPerBattle, 'a:set:lim')],
      [button(s.autoPublish ? b.publishManual : b.publishAuto, 'a:set:t:auto')],
      [button(ctx.locale.admin.buttons.panel, PANEL)],
    ]),
  });
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

  admin.action(/^a:set:t:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    if (!(key in TOGGLES)) return answer(ctx);
    const field = TOGGLES[key as ToggleKey];
    const current = await ctx.deps.services.settings.get();
    await save(ctx, { [field]: !current[field] });
  });

  admin.action('a:set:lim', async (ctx) => {
    await answer(ctx);
    const options = LIMIT_OPTIONS.map((value) => button(String(value), `a:set:lim:${value}`));
    await respond(ctx, ctx.locale.admin.chooseLimit, { keyboard: inline([options, [button(ctx.locale.common.back, 'a:set')]]) });
  });

  admin.action(/^a:set:lim:(\d+)$/, async (ctx) => {
    const value = matchInt(ctx);
    if (!(LIMIT_OPTIONS as readonly number[]).includes(value)) return answer(ctx);
    await save(ctx, { maxPhotosPerBattle: value });
  });
}
