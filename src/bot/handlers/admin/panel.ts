import type { Composer } from 'telegraf';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, respond } from '../../helpers.js';
import { adminPanelKeyboard, backToPanel } from './keyboards.js';
import { adminUserId } from './shared.js';

export async function showPanel(ctx: BotContext, forceNew = false): Promise<void> {
  const { settings, stats } = ctx.deps.services;
  const current = await settings.get();
  const counters = await stats.queueCounters();
  await respond(
    ctx,
    ctx.locale.admin.panelTitle({
      paused: current.publishingPaused,
      interval: ctx.locale.admin.intervalLabel(current.publishIntervalMinutes),
      moderation: current.moderationEnabled,
      queued: counters.queued,
      pending: counters.pending,
    }),
    { keyboard: adminPanelKeyboard(ctx.locale, current.publishingPaused, counters.pending), forceNew },
  );
}

export function registerPanelHandlers(admin: Composer<BotContext>): void {
  admin.action('a:menu', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    const message = ctx.callbackQuery.message;
    await showPanel(ctx, !!message && !('text' in message));
  });

  admin.action('a:cancel', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await respond(ctx, ctx.locale.common.cancelled, { keyboard: backToPanel(ctx.locale) });
  });

  admin.action('a:stats', async (ctx) => {
    await answer(ctx);
    const stats = await ctx.deps.services.stats.botStats();
    await respond(ctx, ctx.locale.admin.stats(stats), { keyboard: backToPanel(ctx.locale) });
  });

  const setPaused = async (ctx: BotContext, paused: boolean) => {
    await ctx.deps.services.settings.update({ publishingPaused: paused }, adminUserId(ctx));
    await answer(ctx, paused ? ctx.locale.admin.paused : ctx.locale.admin.resumed, true);
    await showPanel(ctx);
  };
  admin.action('a:pause', (ctx) => setPaused(ctx, true));
  admin.action('a:resume', (ctx) => setPaused(ctx, false));
}
