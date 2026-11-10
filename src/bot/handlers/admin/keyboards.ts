import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { PhotoStatus } from '../../../generated/prisma/client.js';
import type { Locale } from '../../../i18n/index.js';
import { button, inline } from '../../keyboards.js';

export const PANEL = 'a:menu';

/** Short codes for entry status filters in callback data. */
export const PHOTO_FILTERS: Record<string, PhotoStatus | undefined> = {
  all: undefined,
  mod: 'PENDING_MODERATION',
  acc: 'ACCEPTED',
  in: 'IN_BATTLE',
  out: 'ELIMINATED',
  win: 'WINNER',
  rej: 'REJECTED',
  del: 'DELETED',
};

export const REJECT_REASONS = ['rules', 'quality', 'theme', 'duplicate'] as const;
export type RejectReasonKey = (typeof REJECT_REASONS)[number];

export function adminPanelKeyboard(locale: Locale, pending: number): InlineKeyboardMarkup {
  const b = locale.admin.buttons;
  return inline([
    [button(b.battles, 'a:bt'), button(b.design, 'a:tpl')],
    [button(pending > 0 ? `${b.moderation} (${pending})` : b.moderation, 'a:mod:0'), button(b.photos, 'a:ph:all:0')],
    [button(b.stats, 'a:stats'), button(b.users, 'a:users:0')],
    [button(b.delete, 'a:in:delete'), button(b.settings, 'a:set')],
    [button(b.block, 'a:in:block'), button(b.unblock, 'a:in:unblock')],
    [button(b.broadcast, 'a:bc'), button(b.payments, 'a:pay')],
    [button(b.finalSpots, 'a:fs')],
  ]);
}

export function backToPanel(locale: Locale): InlineKeyboardMarkup {
  return inline([[button(locale.admin.buttons.panel, PANEL)]]);
}

export function moderationKeyboard(locale: Locale, photoId: number): InlineKeyboardMarkup {
  const a = locale.admin.actions;
  return inline([[button(a.approve, `a:pa:${photoId}`), button(a.reject, `a:pr:${photoId}`)]]);
}

export function photoActionsKeyboard(locale: Locale, photo: { id: number; status: PhotoStatus; userId: number }): InlineKeyboardMarkup {
  const a = locale.admin.actions;
  const id = photo.id;
  const rows = [];
  if (photo.status === 'PENDING_MODERATION') rows.push([button(a.approve, `a:pa:${id}`), button(a.reject, `a:pr:${id}`)]);
  if (photo.status === 'ACCEPTED') rows.push([button(a.reject, `a:pr:${id}`)]);
  if (!['DELETED', 'CANCELLED', 'DRAFT'].includes(photo.status)) rows.push([button(a.delete, `a:pd:${id}`)]);
  rows.push([button(a.author, `a:u:${photo.userId}`), button(locale.admin.buttons.panel, PANEL)]);
  return inline(rows);
}
