import type { Telegraf } from 'telegraf';
import { BONUS_VOTES, FRIENDS_PER_BONUS } from '../../modules/referrals/referral.service.js';
import { currentUser, type BotContext } from '../context.js';
import { answer } from '../helpers.js';

/** "👥 Free votes": the user's invite link, progress and a share button. */
export async function showReferrals(ctx: BotContext): Promise<void> {
  const progress = await ctx.deps.services.referrals.progress(currentUser(ctx));
  const l = ctx.locale.referrals;
  const share = `https://t.me/share/url?url=${encodeURIComponent(progress.link)}&text=${encodeURIComponent(l.shareText)}`;
  await ctx.reply(
    l.screen({ link: progress.link, counted: progress.counted % FRIENDS_PER_BONUS, need: FRIENDS_PER_BONUS, votes: BONUS_VOTES, bonuses: progress.bonuses }),
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: l.shareButton, url: share }]] } },
  );
}

export function registerReferralHandlers(bot: Telegraf<BotContext>): void {
  bot.command('invite', showReferrals);
  bot.action('ref:show', async (ctx) => {
    await answer(ctx);
    await showReferrals(ctx);
  });
}
