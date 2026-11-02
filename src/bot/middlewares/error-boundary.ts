import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../context.js';
import { answer, showError } from '../helpers.js';

/** Turns domain errors into user-facing messages and logs everything else. */
export const errorBoundary: MiddlewareFn<BotContext> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    if (await showError(ctx, error).catch(() => false)) return;
    ctx.deps.logger.error({ err: error, updateId: ctx.update.update_id, updateType: ctx.updateType, userId: ctx.from?.id }, 'Unhandled error');
    try {
      if (ctx.callbackQuery) await answer(ctx, ctx.locale.common.unknownError, true);
      else if (ctx.chat?.type === 'private') await ctx.reply(ctx.locale.common.unknownError);
    } catch {
      // The user may have blocked the bot; nothing else to do.
    }
  }
};
