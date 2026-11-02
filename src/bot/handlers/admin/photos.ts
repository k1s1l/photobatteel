import type { Composer } from 'telegraf';
import { channelPostLink, displayName, escapeHtml, formatDateTime, formatPhotoId, truncate } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import type { BotContext } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
import { button, clampPage, inline, paginationRow } from '../../keyboards.js';
import { backToPanel, PANEL, PHOTO_FILTERS, photoActionsKeyboard, REJECT_REASONS, type RejectReasonKey } from './keyboards.js';
import { adminUserId, reportOnCard } from './shared.js';

const PAGE_SIZE = 8;
const ACTION_LOCK_MS = 15_000;

function sizeLabel(photo: { width: number; height: number; fileSize: number }): string {
  return `${photo.width}×${photo.height}, ${(photo.fileSize / 1024 / 1024).toFixed(1)} МБ`;
}

/** Sends the admin card of a photo (image + details + actions). */
export async function showAdminPhotoCard(ctx: BotContext, photoId: number): Promise<void> {
  const photo = await ctx.deps.services.photos.getDetails(photoId);
  if (!photo) {
    await respond(ctx, ctx.locale.admin.photoNotFound, { keyboard: backToPanel(ctx.locale) });
    return;
  }
  const link = photo.publication && !photo.publication.removedAt ? channelPostLink(ctx.deps.channel, photo.publication.messageId) : null;
  const caption = ctx.locale.admin.photoCard({
    id: formatPhotoId(photo.id),
    author: escapeHtml(displayName(photo.user)),
    authorId: photo.user.telegramId.toString(),
    status: ctx.locale.status[photo.status],
    created: formatDateTime(photo.createdAt, ctx.deps.env.TIMEZONE),
    votes: photo.votesCount,
    size: sizeLabel(photo),
    battle: photo.battle ? escapeHtml(photo.battle.title) : null,
    reason: photo.rejectionReason ? escapeHtml(photo.rejectionReason) : null,
    error: photo.queueItem?.lastError ? escapeHtml(truncate(photo.queueItem.lastError, 200)) : null,
    link,
  });
  await ctx.replyWithPhoto(photo.fileId, { caption, parse_mode: 'HTML', reply_markup: photoActionsKeyboard(ctx.locale, photo) });
}

/** Runs a photo action once even if the button is pressed repeatedly. */
async function guarded(ctx: BotContext, key: string, fn: () => Promise<void>): Promise<void> {
  try {
    const done = await ctx.deps.locks.withLock(`admin:${key}`, ACTION_LOCK_MS, async () => {
      await fn();
      return true;
    });
    if (!done) await answer(ctx, ctx.locale.common.busy);
  } catch (error) {
    if (isDomainError(error) && error.code === 'INVALID_STATE') {
      await answer(ctx, ctx.locale.errors.INVALID_STATE(), true);
      return;
    }
    throw error;
  }
}

export function registerPhotoHandlers(admin: Composer<BotContext>): void {
  admin.action(/^a:ph:(\w+):(\d+)$/, async (ctx) => {
    const filterKey = matchString(ctx, 1);
    if (!(filterKey in PHOTO_FILTERS)) return answer(ctx);
    const status = PHOTO_FILTERS[filterKey];
    const { photos } = ctx.deps.services;
    const requested = matchInt(ctx, 2);
    let { items, total } = await photos.listAll(status ? { status } : {}, requested, PAGE_SIZE);
    const page = clampPage(requested, total, PAGE_SIZE);
    if (page !== requested) ({ items, total } = await photos.listAll(status ? { status } : {}, page, PAGE_SIZE));
    await answer(ctx);

    const filterRow = (keys: string[]) =>
      keys.map((key) => {
        const keyStatus = PHOTO_FILTERS[key];
        const label = keyStatus ? ctx.locale.status[keyStatus] : ctx.locale.admin.filterAll;
        return button(key === filterKey ? `• ${label}` : label, `a:ph:${key}:0`);
      });
    const rows = [
      filterRow(['all', 'mod', 'q']),
      filterRow(['pub', 'rej']),
      filterRow(['fail', 'del']),
      ...items.map((photo) => [
        button(`${formatPhotoId(photo.id)} · ${truncate(displayName(photo.user), 20)} · ${ctx.locale.status[photo.status]}`, `a:p:${photo.id}`),
      ]),
      paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `a:ph:${filterKey}:${p}`),
      [button(ctx.locale.admin.buttons.panel, PANEL)],
    ];
    const filterLabel = status ? ctx.locale.status[status] : ctx.locale.admin.filterAll;
    await respond(ctx, ctx.locale.admin.photosTitle({ filter: filterLabel, total }), { keyboard: inline(rows) });
  });

  admin.action(/^a:p:(\d+)$/, async (ctx) => {
    await answer(ctx);
    await showAdminPhotoCard(ctx, matchInt(ctx));
  });

  admin.action(/^a:q:(\d+)$/, async (ctx) => {
    const { publications, settings } = ctx.deps.services;
    const requested = matchInt(ctx);
    let queue = await publications.getQueue(requested, PAGE_SIZE);
    const page = clampPage(requested, queue.total, PAGE_SIZE);
    if (page !== requested) queue = await publications.getQueue(page, PAGE_SIZE);
    const current = await settings.get();
    await answer(ctx);

    const icon = { WAITING: '⏳', PROCESSING: '🚀', FAILED: '⚠️' } as Record<string, string>;
    const position = page * PAGE_SIZE;
    const rows = queue.items.map((item, index) => [
      button(
        `${item.status === 'WAITING' ? `${position + index + 1}. ` : ''}${icon[item.status] ?? ''} ${formatPhotoId(item.photoId)} · ${truncate(displayName(item.photo.user), 20)}`,
        `a:p:${item.photoId}`,
      ),
    ]);
    rows.push(paginationRow(ctx.locale, page, queue.total, PAGE_SIZE, (p) => `a:q:${p}`));
    rows.push([
      current.publishingPaused ? button(ctx.locale.admin.buttons.resume, 'a:resume') : button(ctx.locale.admin.buttons.pause, 'a:pause'),
      button(ctx.locale.admin.buttons.panel, PANEL),
    ]);
    const title = ctx.locale.admin.queueTitle({
      waiting: queue.waiting,
      processing: queue.processing,
      failed: queue.failed,
      paused: current.publishingPaused,
      interval: ctx.locale.admin.intervalLabel(current.publishIntervalMinutes),
    });
    await respond(ctx, queue.total === 0 ? `${title}\n\n${ctx.locale.admin.queueEmpty}` : title, { keyboard: inline(rows) });
  });

  admin.action(/^a:mod:(\d+)$/, async (ctx) => {
    const { photos } = ctx.deps.services;
    const requested = matchInt(ctx);
    let { items, total } = await photos.listAll({ status: 'PENDING_MODERATION' }, requested, PAGE_SIZE);
    const page = clampPage(requested, total, PAGE_SIZE);
    if (page !== requested) ({ items, total } = await photos.listAll({ status: 'PENDING_MODERATION' }, page, PAGE_SIZE));
    await answer(ctx);
    if (total === 0) {
      await respond(ctx, ctx.locale.admin.moderationEmpty, { keyboard: backToPanel(ctx.locale) });
      return;
    }
    const rows = items.map((photo) => [button(`${formatPhotoId(photo.id)} · ${truncate(displayName(photo.user), 24)}`, `a:p:${photo.id}`)]);
    rows.push(paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `a:mod:${p}`));
    rows.push([button(ctx.locale.admin.buttons.panel, PANEL)]);
    await respond(ctx, ctx.locale.admin.moderationTitle(total), { keyboard: inline(rows) });
  });

  admin.action(/^a:pa:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await guarded(ctx, `photo:${photoId}`, async () => {
      await ctx.deps.services.photos.approve(photoId, adminUserId(ctx));
      await answer(ctx);
      await reportOnCard(ctx, ctx.locale.admin.approved(formatPhotoId(photoId)), backToPanel(ctx.locale));
    });
  });

  admin.action(/^a:pr:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await answer(ctx);
    const reasons = REJECT_REASONS.map((key) => [button(ctx.locale.rejectReasons[key], `a:prr:${photoId}:${key}`)]);
    reasons.push([button(ctx.locale.common.cancel, `a:p:${photoId}`)]);
    await respond(ctx, `${formatPhotoId(photoId)} — ${ctx.locale.admin.chooseRejectReason}`, { keyboard: inline(reasons), forceNew: true });
  });

  admin.action(/^a:prr:(\d+):(\w+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    const key = matchString(ctx, 2);
    if (!(REJECT_REASONS as readonly string[]).includes(key)) return answer(ctx);
    await guarded(ctx, `photo:${photoId}`, async () => {
      await ctx.deps.services.photos.reject(photoId, adminUserId(ctx), ctx.locale.rejectReasons[key as RejectReasonKey]);
      await answer(ctx);
      await respond(ctx, ctx.locale.admin.rejected(formatPhotoId(photoId)), { keyboard: backToPanel(ctx.locale) });
    });
  });

  admin.action(/^a:pp:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await guarded(ctx, `photo:${photoId}`, async () => {
      await ctx.deps.services.publications.publishNow(photoId, adminUserId(ctx));
      await answer(ctx);
      await reportOnCard(ctx, ctx.locale.admin.publishQueued(formatPhotoId(photoId)), backToPanel(ctx.locale));
    });
  });

  admin.action(/^a:pq:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await guarded(ctx, `photo:${photoId}`, async () => {
      await ctx.deps.services.photos.requeue(photoId, adminUserId(ctx));
      await answer(ctx);
      await reportOnCard(ctx, ctx.locale.admin.requeued(formatPhotoId(photoId)), backToPanel(ctx.locale));
    });
  });

  admin.action(/^a:pd:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.deleteConfirm(formatPhotoId(photoId)), {
      keyboard: inline([[button(ctx.locale.common.yes, `a:pdy:${photoId}`), button(ctx.locale.common.no, PANEL)]]),
      forceNew: true,
    });
  });

  admin.action(/^a:pdy:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    await guarded(ctx, `photo:${photoId}`, async () => {
      const result = await ctx.deps.services.photos.delete(photoId, { userId: adminUserId(ctx), isAdmin: true });
      const id = formatPhotoId(photoId);
      await answer(ctx);
      await respond(ctx, result.channelRemoved === false ? ctx.locale.admin.deletedChannelFailed(id) : ctx.locale.admin.deleted(id), {
        keyboard: backToPanel(ctx.locale),
      });
    });
  });
}
