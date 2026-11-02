import type { Redis } from 'ioredis';
import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../context.js';
import { answer } from '../helpers.js';

const WINDOW_SECONDS = 60;

/**
 * Fixed-window rate limiter per Telegram user (shared by all instances via Redis).
 * The first excess update gets a warning; further ones are dropped silently.
 */
export function rateLimit(redis: Redis, maxPerWindow: number): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    const key = `ratelimit:${userId}:${Math.floor(Date.now() / 1000 / WINDOW_SECONDS)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS + 5);
    if (count <= maxPerWindow) return next();

    ctx.deps.logger.debug({ userId, count }, 'Rate limit exceeded');
    if (ctx.callbackQuery) {
      await answer(ctx, ctx.locale.common.tooFast, false);
    } else if (count === maxPerWindow + 1 && ctx.chat?.type === 'private') {
      await ctx.reply(ctx.locale.common.tooFast).catch(() => undefined);
    }
  };
}
