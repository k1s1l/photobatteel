import type { InlineKeyboardMarkup } from 'telegraf/types';
import { isDomainError } from '../lib/errors.js';
import { classifyTelegramError } from '../lib/telegram-errors.js';
import type { BotContext } from './context.js';

export interface RespondOptions {
  keyboard?: InlineKeyboardMarkup;
  /** Force a new message even when called from a button. */
  forceNew?: boolean;
}

/**
 * Edits the message the button belongs to (when it is a text message) or sends
 * a new one. Keeps inline navigation in a single message.
 */
export async function respond(ctx: BotContext, text: string, options: RespondOptions = {}): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const extra = {
    parse_mode: 'HTML' as const,
    link_preview_options: { is_disabled: true },
    ...(options.keyboard ? { reply_markup: options.keyboard } : {}),
  };
  if (!options.forceNew && message && 'text' in message) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (error) {
      if (classifyTelegramError(error).kind === 'not_modified') return;
      // Fall through: the message may be too old to edit.
    }
  }
  await ctx.reply(text, extra);
}

/** Answers a callback query, swallowing "query is too old" errors. */
export async function answer(ctx: BotContext, text?: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery) return;
  try {
    await ctx.answerCbQuery(text, { show_alert: alert });
  } catch {
    // Callback queries expire after ~15 seconds; nothing to do.
  }
}

/** Shows a domain error to the user: as an alert for buttons, as a message otherwise. */
export async function showError(ctx: BotContext, error: unknown): Promise<boolean> {
  if (!isDomainError(error)) return false;
  const text = ctx.locale.errors[error.code](error.params);
  if (ctx.callbackQuery) await answer(ctx, stripHtml(text), true);
  else await ctx.reply(text, { parse_mode: 'HTML' });
  return true;
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

/** Extracts an integer from a regex match produced by `bot.action(/.../)`. */
export function matchInt(ctx: BotContext, group = 1): number {
  const match = (ctx as BotContext & { match?: RegExpExecArray }).match;
  const value = Number(match?.[group]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid callback payload');
  return value;
}

export function matchString(ctx: BotContext, group = 1): string {
  const match = (ctx as BotContext & { match?: RegExpExecArray }).match;
  const value = match?.[group];
  if (value === undefined) throw new Error('Invalid callback payload');
  return value;
}
