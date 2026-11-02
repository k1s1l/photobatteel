import type { InlineKeyboardMarkup } from 'telegraf/types';
import { classifyTelegramError } from '../../../lib/telegram-errors.js';
import type { BotContext } from '../../context.js';
import { respond } from '../../helpers.js';

/**
 * Reports the result of an action. When the button belongs to a photo card
 * (e.g. a moderation notification), the caption is replaced; otherwise the text message is edited.
 */
export async function reportOnCard(ctx: BotContext, text: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
  const message = ctx.callbackQuery?.message;
  if (message && 'photo' in message) {
    try {
      await ctx.editMessageCaption(text, { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) });
      return;
    } catch (error) {
      if (classifyTelegramError(error).kind === 'not_modified') return;
    }
  }
  await respond(ctx, text, keyboard ? { keyboard } : {});
}

/** Admin user id for audit fields; the admin guard guarantees ctx.user exists. */
export function adminUserId(ctx: BotContext): number {
  if (!ctx.user || !ctx.isAdmin) throw new Error('Admin context expected');
  return ctx.user.id;
}
