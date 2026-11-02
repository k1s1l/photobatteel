import type { Composer } from 'telegraf';
import type { User } from '../../../generated/prisma/client.js';
import { displayName, escapeHtml, formatDateTime, formatPhotoId, truncate } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import type { BotContext } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, clampPage, inline, paginationRow } from '../../keyboards.js';
import { backToPanel, PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const PAGE_SIZE = 10;

async function showUserCard(ctx: BotContext, userId: number): Promise<void> {
  const { users, admins } = ctx.deps.services;
  const user = await users.findById(userId);
  if (!user) {
    await respond(ctx, ctx.locale.admin.userNotFound, { keyboard: backToPanel(ctx.locale) });
    return;
  }
  const isAdmin = await admins.isAdmin(Number(user.telegramId));
  const tz = ctx.deps.env.TIMEZONE;
  const text = ctx.locale.admin.userCard({
    name: escapeHtml(displayName(user)),
    telegramId: user.telegramId.toString(),
    since: formatDateTime(user.createdAt, tz, ctx.locale.intl),
    lastActive: formatDateTime(user.lastActiveAt, tz, ctx.locale.intl),
    submitted: user.photosSubmitted,
    published: user.photosPublished,
    votes: user.votesReceived,
    blocked: user.isBlocked,
    reason: user.blockedReason ? escapeHtml(user.blockedReason) : null,
    admin: isAdmin,
  });
  const a = ctx.locale.admin.actions;
  const rows = [
    isAdmin ? [] : [user.isBlocked ? button(a.unblock, `a:uu:${user.id}`) : button(a.block, `a:ub:${user.id}`)],
    [button(ctx.locale.admin.userPhotos, `a:up:${user.id}:0`)],
    [button(ctx.locale.common.back, 'a:users:0'), button(ctx.locale.admin.buttons.panel, PANEL)],
  ];
  await respond(ctx, text, { keyboard: inline(rows), forceNew: !!ctx.callbackQuery?.message && !('text' in ctx.callbackQuery.message) });
}

/** Blocks a user (never an admin) and notifies them. Shared by buttons and text input. */
export async function blockUser(ctx: BotContext, target: User): Promise<void> {
  const { users, admins, notifications } = ctx.deps.services;
  if (await admins.isAdmin(Number(target.telegramId))) {
    await respond(ctx, ctx.locale.admin.cannotBlockAdmin, { keyboard: backToPanel(ctx.locale) });
    return;
  }
  try {
    const { cancelledPhotos } = await users.block(target.id, adminUserId(ctx), ctx.locale.rejectReasons.blocked);
    await notifications.notifyUser(target, (l) => l.notifications.blocked);
    await respond(ctx, ctx.locale.admin.userBlocked({ name: escapeHtml(displayName(target)), cancelled: cancelledPhotos }), {
      keyboard: inline([[button(ctx.locale.admin.actions.author, `a:u:${target.id}`), button(ctx.locale.admin.buttons.panel, PANEL)]]),
    });
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'INVALID_STATE') throw error;
    await respond(ctx, ctx.locale.admin.alreadyBlocked, { keyboard: backToPanel(ctx.locale) });
  }
}

export async function unblockUser(ctx: BotContext, target: User): Promise<void> {
  const { users, notifications } = ctx.deps.services;
  try {
    await users.unblock(target.id, adminUserId(ctx));
    await notifications.notifyUser(target, (l) => l.notifications.unblocked);
    await respond(ctx, ctx.locale.admin.userUnblocked(escapeHtml(displayName(target))), {
      keyboard: inline([[button(ctx.locale.admin.actions.author, `a:u:${target.id}`), button(ctx.locale.admin.buttons.panel, PANEL)]]),
    });
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'INVALID_STATE') throw error;
    await respond(ctx, ctx.locale.admin.notBlocked, { keyboard: backToPanel(ctx.locale) });
  }
}

export function registerUserHandlers(admin: Composer<BotContext>): void {
  admin.action(/^a:users:(\d+)$/, async (ctx) => {
    const { users } = ctx.deps.services;
    const requested = matchInt(ctx);
    let { items, total } = await users.list(requested, PAGE_SIZE);
    const page = clampPage(requested, total, PAGE_SIZE);
    if (page !== requested) ({ items, total } = await users.list(page, PAGE_SIZE));
    await answer(ctx);
    const rows = items.map((user) => [
      button(`${user.isBlocked ? '🚫 ' : ''}${truncate(displayName(user), 28)} · 📸 ${user.photosSubmitted} · 🔥 ${user.votesReceived}`, `a:u:${user.id}`),
    ]);
    rows.push(paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `a:users:${p}`));
    rows.push([button(ctx.locale.admin.buttons.panel, PANEL)]);
    await respond(ctx, ctx.locale.admin.usersTitle(total), { keyboard: inline(rows) });
  });

  admin.action(/^a:u:(\d+)$/, async (ctx) => {
    await answer(ctx);
    await showUserCard(ctx, matchInt(ctx));
  });

  admin.action(/^a:ub:(\d+)$/, async (ctx) => {
    const target = await ctx.deps.services.users.findById(matchInt(ctx));
    await answer(ctx);
    if (!target) return respond(ctx, ctx.locale.admin.userNotFound, { keyboard: backToPanel(ctx.locale) });
    await blockUser(ctx, target);
  });

  admin.action(/^a:uu:(\d+)$/, async (ctx) => {
    const target = await ctx.deps.services.users.findById(matchInt(ctx));
    await answer(ctx);
    if (!target) return respond(ctx, ctx.locale.admin.userNotFound, { keyboard: backToPanel(ctx.locale) });
    await unblockUser(ctx, target);
  });

  admin.action(/^a:up:(\d+):(\d+)$/, async (ctx) => {
    const userId = matchInt(ctx, 1);
    const requested = matchInt(ctx, 2);
    const { photos } = ctx.deps.services;
    let { items, total } = await photos.listAll({ userId }, requested, PAGE_SIZE);
    const page = clampPage(requested, total, PAGE_SIZE);
    if (page !== requested) ({ items, total } = await photos.listAll({ userId }, page, PAGE_SIZE));
    await answer(ctx);
    const rows = items.map((photo) => [button(`${formatPhotoId(photo.id)} · ${ctx.locale.status[photo.status]}`, `a:p:${photo.id}`)]);
    rows.push(paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `a:up:${userId}:${p}`));
    rows.push([button(ctx.locale.common.back, `a:u:${userId}`), button(ctx.locale.admin.buttons.panel, PANEL)]);
    const name = items[0] ? escapeHtml(displayName(items[0].user)) : '';
    await respond(ctx, ctx.locale.admin.photosTitle({ filter: name || ctx.locale.admin.filterAll, total }), { keyboard: inline(rows) });
  });
}
