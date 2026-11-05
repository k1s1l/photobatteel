import type { Composer } from 'telegraf';
import { escapeHtml } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, respond } from '../../helpers.js';
import { adminPanelKeyboard, backToPanel } from './keyboards.js';

export async function showPanel(ctx: BotContext, forceNew = false): Promise<void> {
  const { settings, stats, battles } = ctx.deps.services;
  const [current, pending, battle] = await Promise.all([settings.get(), stats.pendingModeration(), battles.getCurrent()]);
  await respond(ctx, ctx.locale.admin.panelTitle({ battle: battle ? escapeHtml(battle.title) : null, pending, paid: current.paidVotesEnabled }), {
    keyboard: adminPanelKeyboard(ctx.locale, pending),
    forceNew,
  });
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
}
