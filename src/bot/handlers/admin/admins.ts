import type { Composer } from 'telegraf';
import { displayName, escapeHtml } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

async function ownerOnly(ctx: BotContext): Promise<boolean> {
  if (ctx.from && (await ctx.deps.services.admins.isOwner(ctx.from.id))) return true;
  await answer(ctx, ctx.locale.admin.admins.ownerOnly, true);
  return false;
}

/** "👮 Admins": who has access, add by @username or id, remove. */
export async function showAdmins(ctx: BotContext): Promise<void> {
  const a = ctx.locale.admin.admins;
  const admins = await ctx.deps.services.admins.list();
  const lines = admins.map((admin, index) => {
    const name = admin.user ? escapeHtml(displayName(admin.user)) : a.notStarted;
    return `${index + 1}. ${name} · <code>${admin.telegramId.toString()}</code>${admin.role === 'OWNER' ? ` · ${a.owner}` : ''}`;
  });
  const removable = admins.filter((admin) => admin.role !== 'OWNER');
  await respond(ctx, `${a.title}\n\n${lines.join('\n')}\n\n${a.hint}`, {
    keyboard: inline([
      [button(a.add, 'a:adm:add')],
      ...removable.map((admin) => [button(a.remove(admin.user ? displayName(admin.user) : admin.telegramId.toString()), `a:adm:rm:${admin.id}`)]),
      [button(ctx.locale.admin.buttons.panel, PANEL)],
    ]),
  });
}

/** Text answer to "who is the new admin": @username or a numeric Telegram id. */
export async function handleAddAdminInput(ctx: BotContext, text: string): Promise<void> {
  const a = ctx.locale.admin.admins;
  const value = text.trim();
  let telegramId: number | null = /^\d{5,15}$/.test(value) ? Number(value) : null;
  if (telegramId === null) {
    const user = await ctx.deps.services.users.findByQuery(value);
    telegramId = user ? Number(user.telegramId) : null;
  }
  if (telegramId === null) {
    await ctx.reply(a.notFound, { parse_mode: 'HTML', reply_markup: inline([[button(ctx.locale.common.cancel, 'a:adm')]]) });
    return;
  }
  setState(ctx, undefined);
  await ctx.deps.services.admins.add(telegramId, adminUserId(ctx));
  await ctx.reply(a.added(telegramId), { parse_mode: 'HTML', reply_markup: inline([[button(a.back, 'a:adm')]]) });
}

export function registerAdminManagementHandlers(admin: Composer<BotContext>): void {
  admin.action('a:adm', async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    setState(ctx, undefined);
    await answer(ctx);
    await showAdmins(ctx);
  });

  admin.action('a:adm:add', async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    await answer(ctx);
    setState(ctx, { kind: 'admin_input', action: 'admin_add' });
    await respond(ctx, ctx.locale.admin.admins.ask, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:adm')]]), forceNew: true });
  });

  admin.action(/^a:adm:rm:(\d+)$/, async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.admins.removeConfirm, {
      keyboard: inline([[button(ctx.locale.common.yes, `a:adm:rmy:${matchInt(ctx)}`), button(ctx.locale.common.no, 'a:adm')]]),
    });
  });

  admin.action(/^a:adm:rmy:(\d+)$/, async (ctx) => {
    if (!(await ownerOnly(ctx))) return;
    const done = await ctx.deps.services.admins.remove(matchInt(ctx), adminUserId(ctx));
    await answer(ctx, done ? ctx.locale.admin.admins.removed : ctx.locale.common.alreadyProcessed, !done);
    await showAdmins(ctx);
  });
}
