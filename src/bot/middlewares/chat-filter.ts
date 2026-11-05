import type { MiddlewareFn } from 'telegraf';
import { DUEL_CLOSED, DUEL_PAID_PREFIX, DUEL_VOTE_PREFIX } from '../../modules/duels/duel-post.js';
import type { BotContext } from '../context.js';

const CHANNEL_CALLBACKS = [DUEL_VOTE_PREFIX, DUEL_PAID_PREFIX, DUEL_CLOSED];

/**
 * The bot talks to people only in private chats. Exceptions: the vote buttons
 * under channel posts and payment pre-checkout queries (which have no chat).
 */
export const chatFilter: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.preCheckoutQuery) return next();
  if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
    const data = ctx.callbackQuery.data;
    if (CHANNEL_CALLBACKS.some((prefix) => data.startsWith(prefix))) return next();
  }
  if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) return next();
};
