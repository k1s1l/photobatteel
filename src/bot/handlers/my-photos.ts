import type { Telegraf } from 'telegraf';
import { allTranslations } from '../../i18n/index.js';
import { channelPostLink, escapeHtml, formatDateTime, formatPhotoId } from '../../lib/format.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, matchInt, respond } from '../helpers.js';
import { button, clampPage, inline, paginationRow } from '../keyboards.js';

const PAGE_SIZE = 8;
const DELETE_ALL_LOCK_MS = 120_000;

async function showList(ctx: BotContext, requestedPage: number): Promise<void> {
  const user = currentUser(ctx);
  const { photos } = ctx.deps.services;
  let { items, total } = await photos.listByUser(user.id, requestedPage, PAGE_SIZE);
  const page = clampPage(requestedPage, total, PAGE_SIZE);
  if (page !== requestedPage) ({ items, total } = await photos.listByUser(user.id, page, PAGE_SIZE));
  if (total === 0) {
    await respond(ctx, ctx.locale.myPhotos.empty);
    return;
  }
  const rows = items.map((photo) => [button(`${formatPhotoId(photo.id)} · ${ctx.locale.status[photo.status]}`, `my:v:${photo.id}`)]);
  rows.push(paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `my:${p}`));
  await respond(ctx, ctx.locale.myPhotos.title(total), { keyboard: inline(rows) });
}

async function showCard(ctx: BotContext, photoId: number): Promise<void> {
  const user = currentUser(ctx);
  const photo = await ctx.deps.services.photos.getDetails(photoId);
  if (!photo || photo.userId !== user.id || photo.status === 'CANCELLED') {
    await answer(ctx, ctx.locale.common.notFound, true);
    return;
  }
  const { env, channel } = ctx.deps;
  const link = photo.publication && !photo.publication.removedAt ? channelPostLink(channel, photo.publication.messageId) : null;
  const caption = ctx.locale.myPhotos.card({
    id: formatPhotoId(photo.id),
    status: ctx.locale.status[photo.status],
    date: formatDateTime(photo.createdAt, env.TIMEZONE),
    votes: photo.votesCount,
    battle: photo.battle ? escapeHtml(photo.battle.title) : null,
    link,
    reason: photo.status === 'REJECTED' && photo.rejectionReason ? escapeHtml(photo.rejectionReason) : null,
  });
  const actions = photo.status === 'DELETED' ? [] : [button(ctx.locale.myPhotos.delete, `my:d:${photo.id}`)];
  const keyboard = inline([actions, [button(ctx.locale.common.back, 'my:0')]]);
  await answer(ctx);
  if (photo.status === 'DELETED') {
    await respond(ctx, caption, { keyboard });
    return;
  }
  await ctx.replyWithPhoto(photo.fileId, { caption, parse_mode: 'HTML', reply_markup: keyboard });
}

export function registerMyPhotosHandlers(bot: Telegraf<BotContext>): void {
  bot.hears(allTranslations((l) => l.menu.myPhotos), (ctx) => showList(ctx, 0));
  bot.command('myphotos', (ctx) => showList(ctx, 0));

  bot.action(/^my:(\d+)$/, async (ctx) => {
    await answer(ctx);
    await showList(ctx, matchInt(ctx));
  });

  bot.action(/^my:v:(\d+)$/, (ctx) => showCard(ctx, matchInt(ctx)));

  bot.action(/^my:d:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await answer(ctx);
    await respond(ctx, ctx.locale.myPhotos.deleteConfirm(formatPhotoId(photoId)), {
      keyboard: inline([[button(ctx.locale.common.yes, `my:dy:${photoId}`), button(ctx.locale.common.no, `my:v:${photoId}`)]]),
    });
  });

  bot.action(/^my:dy:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    const user = currentUser(ctx);
    const result = await ctx.deps.services.photos.delete(photoId, { userId: user.id, isAdmin: false });
    const id = formatPhotoId(photoId);
    await answer(ctx);
    await respond(ctx, result.channelRemoved === false ? ctx.locale.myPhotos.deletedChannelFailed(id) : ctx.locale.myPhotos.deleted(id), {
      keyboard: inline([[button(ctx.locale.common.back, 'my:0')]]),
    });
  });

  bot.command('deletedata', async (ctx) => {
    await ctx.reply(ctx.locale.myPhotos.deleteAllConfirm, {
      parse_mode: 'HTML',
      reply_markup: inline([[button(ctx.locale.common.yes, 'my:dall'), button(ctx.locale.common.no, 'my:dall:no')]]),
    });
  });

  bot.action('my:dall:no', async (ctx) => {
    await answer(ctx);
    await respond(ctx, ctx.locale.common.cancelled);
  });

  bot.action('my:dall', async (ctx) => {
    const user = currentUser(ctx);
    await answer(ctx);
    const deleted = await ctx.deps.locks.withLock(`delete-all:${user.id}`, DELETE_ALL_LOCK_MS, () =>
      ctx.deps.services.photos.deleteAllForUser(user.id),
    );
    if (deleted === undefined) {
      await ctx.reply(ctx.locale.common.busy);
      return;
    }
    await respond(ctx, ctx.locale.myPhotos.deleteAllDone(deleted));
  });
}
