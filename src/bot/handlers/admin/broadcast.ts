import type { Composer } from 'telegraf';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { backToPanel } from './keyboards.js';
import { adminUserId } from './shared.js';

const BROADCAST_ONCE_MS = 24 * 60 * 60_000;

/** Called by the admin input router when an admin in broadcast mode sends any message. */
export async function previewBroadcast(ctx: BotContext, messageId: number): Promise<void> {
  if (!ctx.chat) return;
  setState(ctx, undefined);
  await ctx.telegram.copyMessage(ctx.chat.id, ctx.chat.id, messageId);
  await ctx.reply(ctx.locale.admin.broadcastPreview, {
    reply_markup: inline([[button(ctx.locale.admin.broadcastSend, `a:bc:send:${messageId}`), button(ctx.locale.common.cancel, 'a:cancel')]]),
  });
}

export function registerBroadcastHandlers(admin: Composer<BotContext>): void {
  admin.action('a:bc', async (ctx) => {
    setState(ctx, { kind: 'admin_broadcast' });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.broadcastAsk, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]) });
  });

  admin.action(/^a:bc:send:(\d+)$/, async (ctx) => {
    const messageId = matchInt(ctx);
    const chatId = ctx.chat?.id;
    if (!chatId) return answer(ctx);
    // A given preview can be broadcast only once, regardless of repeated presses.
    const first = await ctx.deps.locks.acquire(`broadcast:${chatId}:${messageId}`, BROADCAST_ONCE_MS);
    if (!first) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    const { recipients } = await ctx.deps.services.broadcasts.create(adminUserId(ctx), chatId, messageId);
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.broadcastStarted(recipients), { keyboard: backToPanel(ctx.locale) });
  });
}
