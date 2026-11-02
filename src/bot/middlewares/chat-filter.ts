import type { MiddlewareFn } from 'telegraf';
import { BOOST_CALLBACK_PREFIX, VOTE_CALLBACK_PREFIX } from '../../modules/publications/channel-post.js';
import type { BotContext } from '../context.js';

/**
 * The bot talks to people only in private chats. The single exception is the
 * vote buttons under channel posts and payment pre-checkout queries (which have no chat).
 * Group messages and channel posts are ignored.
 */
export const chatFilter: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.preCheckoutQuery) return next();
  if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
    const data = ctx.callbackQuery.data;
    if (data.startsWith(VOTE_CALLBACK_PREFIX) || data.startsWith(BOOST_CALLBACK_PREFIX)) return next();
  }
  if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) return next();
};
