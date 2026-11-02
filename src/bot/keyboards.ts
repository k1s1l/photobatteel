import { Markup } from 'telegraf';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import type { Locale } from '../i18n/index.js';

type Button = InlineKeyboardButton.CallbackButton;

export const NOOP = 'noop';

export function mainMenu(locale: Locale, isAdmin: boolean) {
  const rows = [
    [locale.menu.submit],
    [locale.menu.myPhotos, locale.menu.myStats],
    [locale.menu.rating, locale.menu.battle],
    [locale.menu.rules, locale.menu.help],
  ];
  if (isAdmin) rows.push([locale.menu.admin]);
  return Markup.keyboard(rows).resize().persistent();
}

export function button(text: string, data: string): Button {
  return Markup.button.callback(text, data);
}

export function inline(rows: Button[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

/** "◀️ 2/5 ▶️" row; `makeData(page)` builds callback data for a zero-based page. */
export function paginationRow(locale: Locale, page: number, totalItems: number, pageSize: number, makeData: (page: number) => string): Button[] {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (totalPages <= 1) return [];
  return [
    button(locale.common.prev, page > 0 ? makeData(page - 1) : NOOP),
    button(`${page + 1}/${totalPages}`, NOOP),
    button(locale.common.next, page < totalPages - 1 ? makeData(page + 1) : NOOP),
  ];
}

/** Clamps a page index coming from callback data. */
export function clampPage(page: number, totalItems: number, pageSize: number): number {
  const last = Math.max(0, Math.ceil(totalItems / pageSize) - 1);
  return Math.min(Math.max(0, page), last);
}
