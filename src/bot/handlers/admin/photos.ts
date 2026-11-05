import type { Composer } from 'telegraf';
import { displayName, escapeHtml, formatDateTime, formatPhotoId, truncate } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import type { BotContext } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
import { button, clampPage, inline, paginationRow } from '../../keyboards.js';
import { backToPanel, PANEL, PHOTO_FILTERS, photoActionsKeyboard, REJECT_REASONS, type RejectReasonKey } from './keyboards.js';
import { adminUserId, reportOnCard } from './shared.js';

const PAGE_SIZE = 8;
const ACTION_LOCK_MS = 15_000;

function sizeLabel(photo: { width: number; height: number; fileSize: number; durationSec: number | null }): string {
  const base = `${photo.width}×${photo.height}, ${(photo.fileSize / 1024 / 1024).toFixed(1)} МБ`;
  return photo.durationSec ? `${base}, ${photo.durationSec} s` : base;
}

/** Sends the admin card of an entry (media + details + actions). */
export async function showAdminPhotoCard(ctx: BotContext, photoId: number): Promise<void> {
  const photo = await ctx.deps.services.photos.getDetails(photoId);
  if (!photo) {
    await respond(ctx, ctx.locale.admin.photoNotFound, { keyboard: backToPanel(ctx.locale) });
    return;
  }
  const caption = ctx.locale.admin.photoCard({
    id: formatPhotoId(photo.id),
    type: ctx.locale.mediaType[photo.mediaType],
    author: escapeHtml(displayName(photo.user)),
    authorId: photo.user.telegramId.toString(),
    status: ctx.locale.status[photo.status],
    created: formatDateTime(photo.createdAt, ctx.deps.env.TIMEZONE, ctx.locale.intl),
    size: sizeLabel(photo),
    votes: photo.votesCount,
    battle: photo.battle ? escapeHtml(photo.battle.title) : null,
    reason: photo.rejectionReason ? escapeHtml(photo.rejectionReason) : null,
  });
  const extra = { caption, parse_mode: 'HTML' as const, reply_markup: photoActionsKeyboard(ctx.locale, photo) };
  if (photo.mediaType === 'VIDEO') await ctx.replyWithVideo(photo.fileId, extra);
  else await ctx.replyWithPhoto(photo.fileId, extra);
}

/** Runs an entry action once even if the button is pressed repeatedly. */
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

/** Shared by the delete button and the "delete by id" prompt. */
export async function deleteEntry(ctx: BotContext, photoId: number): Promise<void> {
  const result = await ctx.deps.services.photos.delete(photoId, { userId: adminUserId(ctx), isAdmin: true });
  const id = formatPhotoId(photoId);
  await respond(ctx, result.forfeited ? ctx.locale.admin.deletedForfeit(id) : ctx.locale.admin.deleted(id), { keyboard: backToPanel(ctx.locale) });
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
      filterRow(['all', 'mod', 'acc']),
      filterRow(['in', 'out', 'win']),
      filterRow(['rej', 'del']),
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
    const rows = items.map((photo) => [button(`${formatPhotoId(photo.id)} · ${ctx.locale.mediaType[photo.mediaType]} · ${truncate(displayName(photo.user), 20)}`, `a:p:${photo.id}`)]);
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
      await answer(ctx);
      await deleteEntry(ctx, photoId);
    });
  });
}
