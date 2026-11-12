import type { Telegraf } from 'telegraf';
import { isDomainError } from '../../lib/errors.js';
import { DUEL_CLOSED, DUEL_TIME } from '../../modules/duels/duel-post.js';
import { sideFromLetter, sideNumber } from '../../modules/duels/sides.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, matchInt, matchString, stripHtml } from '../helpers.js';

const VOTE_LOCK_MS = 3_000;

/** Buttons under duel posts in the channel. */
export function registerVoteHandlers(bot: Telegraf<BotContext>): void {
  bot.action(/^d:(\d+):(\d+):([a-f])$/, async (ctx) => {
    const duelId = matchInt(ctx, 1);
    const stage = matchInt(ctx, 2);
    const side = sideFromLetter(matchString(ctx, 3))!;
    const user = currentUser(ctx);
    try {
      const result = await ctx.deps.locks.withLock(`vote:${user.id}:${duelId}`, VOTE_LOCK_MS, () =>
        ctx.deps.services.duelVotes.vote(duelId, stage, side, user),
      );
      if (!result) return answer(ctx, ctx.locale.common.busy);
      // A friend who came through an invite link counts once they vote.
      if (result.side) await ctx.deps.services.referrals.countVote(user.id);
      await answer(ctx, result.side ? ctx.locale.duel.voted(sideNumber(result.side)) : ctx.locale.duel.withdrawn);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      await answer(ctx, stripHtml(ctx.locale.errors[error.code](error.params)), true);
    }
  });

  // "⭐ +1": paid votes are chosen and paid for in the bot.
  bot.action(/^dp:(\d+)$/, async (ctx) => {
    const duelId = matchInt(ctx);
    const url = `https://t.me/${ctx.botInfo.username}?start=duel_${duelId}`;
    try {
      await ctx.answerCbQuery(undefined, { url });
    } catch {
      await answer(ctx);
    }
  });

  bot.action(DUEL_CLOSED, (ctx) => answer(ctx, ctx.locale.duel.closed));
  bot.action(DUEL_TIME, (ctx) => answer(ctx, ctx.locale.duel.timeHint));
}
