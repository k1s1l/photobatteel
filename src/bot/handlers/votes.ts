import type { Telegraf } from 'telegraf';
import { isDomainError } from '../../lib/errors.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, matchInt, stripHtml } from '../helpers.js';

const VOTE_LOCK_MS = 3_000;

/** "🔥 Support" button under channel posts. */
export function registerVoteHandlers(bot: Telegraf<BotContext>): void {
  bot.action(/^v:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    const user = currentUser(ctx);
    try {
      const result = await ctx.deps.locks.withLock(`vote:${user.id}:${photoId}`, VOTE_LOCK_MS, () => ctx.deps.services.votes.toggle(photoId, user));
      if (!result) return answer(ctx, ctx.locale.common.busy);
      await answer(ctx, result.voted ? ctx.locale.vote.added : ctx.locale.vote.removed);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      const text = error.code === 'NOT_FOUND' ? ctx.locale.vote.unavailable : stripHtml(ctx.locale.errors[error.code](error.params));
      await answer(ctx, text, true);
    }
  });
}
