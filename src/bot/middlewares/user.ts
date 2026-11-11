import type { MiddlewareFn } from 'telegraf';
import { getLocale } from '../../i18n/index.js';
import type { BotContext } from '../context.js';
import { answer } from '../helpers.js';

/** Registers/refreshes the sender and resolves admin rights from the database. */
export const loadUser: MiddlewareFn<BotContext> = async (ctx, next) => {
  ctx.isAdmin = false;
  ctx.locale = getLocale(ctx.deps.env.DEFAULT_LANGUAGE);
  if (!ctx.from || ctx.from.is_bot) return;

  const { users, admins } = ctx.deps.services;
  // Votes under channel posts come with the channel message: the user may never have opened the bot.
  const privateChat = ctx.chat?.type === 'private' || (!ctx.chat && !ctx.callbackQuery);
  const { user, isNew } = await users.upsertFromTelegram(ctx.from, { privateChat });
  ctx.user = user;
  ctx.isNewUser = isNew;
  ctx.locale = getLocale(user.languageCode);
  ctx.isAdmin = await admins.isAdmin(ctx.from.id);
  if (ctx.isAdmin && isNew) await admins.linkUser(ctx.from.id, user.id);
  return next();
};

/** Stops blocked users (admins are never blocked). */
export const blockedGuard: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.user?.isBlocked || ctx.isAdmin) return next();
  if (ctx.preCheckoutQuery) {
    await ctx.answerPreCheckoutQuery(false, ctx.locale.common.blocked).catch(() => undefined);
    return;
  }
  if (ctx.callbackQuery) {
    await answer(ctx, ctx.locale.common.blocked, true);
    return;
  }
  // Reply at most once per hour so a blocked user cannot make the bot spam.
  const acquired = await ctx.deps.locks.acquire(`blocked-notice:${ctx.from?.id}`, 60 * 60_000);
  if (acquired) await ctx.reply(ctx.locale.common.blocked, { reply_markup: { remove_keyboard: true } }).catch(() => undefined);
};
