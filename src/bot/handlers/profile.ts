import type { Telegraf } from 'telegraf';
import type { Battle } from '../../generated/prisma/client.js';
import { allTranslations, type Locale } from '../../i18n/index.js';
import { displayName, escapeHtml, formatDate, formatDateTime, formatPhotoId } from '../../lib/format.js';
import { currentUser, type BotContext } from '../context.js';

const RATING_SIZE = 10;
const BATTLE_LEADERS = 5;

export function battleStatusLabel(locale: Locale, battle: Battle): string {
  switch (battle.status) {
    case 'ACTIVE':
      return locale.battle.statusActive;
    case 'VOTING':
      return locale.battle.statusVoting;
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
      since: formatDate(stats.user.createdAt, ctx.deps.env.TIMEZONE),
      submitted: stats.user.photosSubmitted,
      published: stats.user.photosPublished,
      queued: stats.queued,
      votes: stats.user.votesReceived,
      rank: stats.rank,
    }),
    { parse_mode: 'HTML' },
  );
}

async function showRating(ctx: BotContext): Promise<void> {
  const { users, battles } = ctx.deps.services;
  const top = await users.topByVotes(RATING_SIZE);
  const lines = [ctx.locale.rating.title, ''];
  if (top.length === 0) lines.push(ctx.locale.rating.empty);
  top.forEach((user, index) =>
    lines.push(ctx.locale.rating.row({ place: index + 1, name: escapeHtml(displayName(user)), votes: user.votesReceived, published: user.photosPublished })),
  );

  const battle = await battles.getCurrent();
  if (battle) {
    const leaders = await battles.leaderboard(battle.id, BATTLE_LEADERS);
    if (leaders.length > 0) {
      lines.push(ctx.locale.rating.battleTitle(escapeHtml(battle.title)));
      leaders.forEach((photo, index) =>
        lines.push(
          ctx.locale.rating.battleRow({ place: index + 1, id: formatPhotoId(photo.id), name: escapeHtml(displayName(photo.user)), votes: photo.votesCount }),
        ),
      );
    }
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

async function showBattle(ctx: BotContext): Promise<void> {
  const { battles } = ctx.deps.services;
  const battle = await battles.getCurrent();
  if (!battle) {
    await ctx.reply(ctx.locale.battle.none);
    return;
  }
  const tz = ctx.deps.env.TIMEZONE;
  await ctx.reply(
    ctx.locale.battle.info({
      title: escapeHtml(battle.title),
      theme: battle.theme ? escapeHtml(battle.theme) : null,
      status: battleStatusLabel(ctx.locale, battle),
      submissionsEnd: formatDateTime(battle.submissionsEndAt, tz),
      end: formatDateTime(battle.endsAt, tz),
      participants: await battles.participantsCount(battle.id),
    }),
    { parse_mode: 'HTML' },
  );
}

export function registerProfileHandlers(bot: Telegraf<BotContext>): void {
  bot.hears(allTranslations((l) => l.menu.myStats), showStats);
  bot.command('stats', showStats);
  bot.hears(allTranslations((l) => l.menu.rating), showRating);
  bot.command('rating', showRating);
  bot.hears(allTranslations((l) => l.menu.battle), showBattle);
  bot.command('battle', showBattle);
}
