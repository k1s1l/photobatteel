import type { MiddlewareFn } from 'telegraf';
import { VOTE_CALLBACK_PREFIX } from '../../modules/publications/channel-post.js';
import type { BotContext } from '../context.js';

/**
 * The bot talks to people only in private chats. The single exception is the
 * vote button under channel posts. Group messages and channel posts are ignored.
 */
export const chatFilter: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.callbackQuery && 'data' in ctx.callbackQuery && ctx.callbackQuery.data.startsWith(VOTE_CALLBACK_PREFIX)) return next();
  if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) return next();
};
