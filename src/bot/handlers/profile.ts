import type { Telegraf } from 'telegraf';
import type { Battle } from '../../generated/prisma/client.js';
import { allTranslations, type Locale } from '../../i18n/index.js';
import { escapeHtml, formatDate, formatDateTime } from '../../lib/format.js';
import { currentUser, type BotContext } from '../context.js';
import { button, inline } from '../keyboards.js';

export function battleStatusLabel(locale: Locale, battle: Battle): string {
  switch (battle.status) {
    case 'SCHEDULED':
      return locale.battle.statusScheduled;
    case 'RUNNING':
      return locale.battle.statusRunning;
    case 'FINISHED':
      return locale.battle.statusFinished;
    case 'CANCELLED':
      return locale.battle.statusCancelled;
  }
}

async function showStats(ctx: BotContext): Promise<void> {
  const stats = await ctx.deps.services.users.getStats(currentUser(ctx).id);
  await ctx.reply(
    ctx.locale.stats.text({
      since: formatDate(stats.user.createdAt, ctx.deps.env.TIMEZONE, ctx.locale.intl),
      submitted: stats.user.photosSubmitted,
      waiting: stats.queued,
      votes: stats.user.votesReceived,
      balance: stats.user.voteBalance,
    }),
    { parse_mode: 'HTML' },
  );
}

async function showBattle(ctx: BotContext): Promise<void> {
  const { battles } = ctx.deps.services;
  const battle = await battles.getCurrent();
  if (!battle) {
    await ctx.reply(ctx.locale.battle.none);
    return;
  }
  // A place in the final for Stars, when it is on sale for this user.
  const offer = await ctx.deps.services.finalSpots.offer(currentUser(ctx));
  const keyboard = offer.available ? inline([[button(ctx.locale.finalSpot.button(offer.price), 'fs:buy')]]) : undefined;
  await ctx.reply(
    ctx.locale.battle.info({
      title: escapeHtml(battle.title),
      status: battleStatusLabel(ctx.locale, battle),
      start: formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl),
      round: battle.currentRound,
      entries: await battles.entriesCount(battle.id),
    }),
    { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) },
  );
  const spot = await ctx.deps.services.finalSpots.openSpot(currentUser(ctx).id);
  if (spot && !spot.photoId) await ctx.reply(ctx.locale.finalSpot.waitingPhoto);
}

export function registerProfileHandlers(bot: Telegraf<BotContext>): void {
  bot.command('stats', showStats);
  bot.hears(allTranslations((l) => l.menu.battle), showBattle);
  bot.command('battle', showBattle);
}
