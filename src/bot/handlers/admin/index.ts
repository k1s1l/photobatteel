import { Composer, type Telegraf } from 'telegraf';
import { allTranslations } from '../../../i18n/index.js';
import { isDomainError } from '../../../lib/errors.js';
import { formatPhotoId, parsePhotoId } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';
import { getState, setState } from '../../context.js';
import { answer, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { handleBattleWizardText, registerBattleHandlers } from './battles.js';
import { handleTemplateMessage, registerDesignHandlers } from './design.js';
import { previewBroadcast, registerBroadcastHandlers } from './broadcast.js';
import { backToPanel } from './keyboards.js';
import { registerPanelHandlers, showPanel } from './panel.js';
import { handlePackagePriceInput, handleTransferDetailsInput, registerPaymentAdminHandlers } from './payments.js';
import { registerPhotoHandlers } from './photos.js';
import { registerSettingsHandlers } from './settings.js';
import { blockUser, registerUserHandlers, unblockUser } from './users.js';

const ADMIN_STATES = new Set(['admin_input', 'admin_broadcast', 'admin_template', 'battle_create', 'monobank_pick']);
const MENU_BUTTONS = new Set(
  (['submit', 'votes', 'battle', 'rules', 'help'] as const).flatMap((key) => allTranslations((l) => l.menu[key])),
);
const ADMIN_BUTTONS = new Set(allTranslations((l) => l.menu.admin));

/** Does this update target the admin area (buttons, commands or an admin dialog step)? */
function isAdminUpdate(ctx: BotContext): boolean {
  if (ctx.callbackQuery && 'data' in ctx.callbackQuery) return ctx.callbackQuery.data.startsWith('a:');
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
  if (text && (ADMIN_BUTTONS.has(text) || /^\/admin(@\w+)?$/.test(text))) return true;
  const state = getState(ctx);
  return !!state && ADMIN_STATES.has(state.kind);
}

/**
 * Server-side permission check for every admin update. Rights come from the
 * database (Admin table), never from anything the client sends.
 */
const adminGuard = async (ctx: BotContext, next: () => Promise<void>) => {
  if (ctx.isAdmin && ctx.from) return next();
  setState(ctx, undefined);
  if (ctx.from) {
    try {
      await ctx.deps.services.admins.assertAdmin(ctx.from.id); // records the denied attempt
    } catch (error) {
      if (!isDomainError(error)) throw error;
    }
  }
  if (ctx.callbackQuery) await answer(ctx, ctx.locale.admin.accessDenied, true);
  else await ctx.reply(ctx.locale.admin.accessDenied);
};

/** Text/media replies to admin prompts (photo id, user, broadcast content, battle wizard). */
async function adminInputRouter(ctx: BotContext, next: () => Promise<void>): Promise<void> {
  const state = getState(ctx);
  const message = ctx.message;
  if (!state || !message) return next();
  const text = 'text' in message ? message.text.trim() : undefined;

  // Menu buttons and commands always win over a pending admin prompt.
  if (text && (MENU_BUTTONS.has(text) || text.startsWith('/'))) {
    setState(ctx, undefined);
    return next();
  }

  if (state.kind === 'admin_broadcast') return previewBroadcast(ctx, message.message_id);
  if (state.kind === 'admin_template') return handleTemplateMessage(ctx, message, state.key, state.variant);
  if (!text) return next();
  if (state.kind === 'battle_create') return handleBattleWizardText(ctx, text);
  if (state.kind !== 'admin_input') return next();
  if (state.action === 'transfer_details') return handleTransferDetailsInput(ctx, text);
  if (state.action === 'package_price') {
    if (state.packageId) await handlePackagePriceInput(ctx, state.packageId, text);
    else setState(ctx, undefined);
    return;
  }

  const { services } = ctx.deps;
  const retry = inline([[button(ctx.locale.common.cancel, 'a:cancel')]]);

  if (state.action === 'delete') {
    const photoId = parsePhotoId(text);
    if (!photoId) {
      await ctx.reply(ctx.locale.admin.invalidPhotoId, { reply_markup: retry });
      return;
    }
    setState(ctx, undefined);
    const photo = await services.photos.getDetails(photoId);
    if (!photo) {
      await ctx.reply(ctx.locale.admin.photoNotFound, { reply_markup: backToPanel(ctx.locale) });
      return;
    }
    await ctx.reply(ctx.locale.admin.deleteConfirm(formatPhotoId(photoId)), {
      reply_markup: inline([[button(ctx.locale.common.yes, `a:pdy:${photoId}`), button(ctx.locale.common.no, 'a:menu')]]),
    });
    return;
  }

  const target = await services.users.findByQuery(text);
  if (!target) {
    await ctx.reply(ctx.locale.admin.userNotFound, { reply_markup: retry });
    return;
  }
  setState(ctx, undefined);
  if (state.action === 'block') await blockUser(ctx, target);
  else await unblockUser(ctx, target);
}

export function registerAdminHandlers(bot: Telegraf<BotContext>): void {
  const admin = new Composer<BotContext>();

  admin.command('admin', async (ctx) => {
    setState(ctx, undefined);
    await showPanel(ctx, true);
  });
  admin.hears([...ADMIN_BUTTONS], async (ctx) => {
    setState(ctx, undefined);
    await showPanel(ctx, true);
  });

  registerPanelHandlers(admin);
  registerPhotoHandlers(admin);
  registerUserHandlers(admin);
  registerSettingsHandlers(admin);
  registerBroadcastHandlers(admin);
  registerBattleHandlers(admin);
  registerPaymentAdminHandlers(admin);
  registerDesignHandlers(admin);

  const prompts = {
    delete: (ctx: BotContext) => ctx.locale.admin.askPhotoIdDelete,
    block: (ctx: BotContext) => ctx.locale.admin.askUserBlock,
    unblock: (ctx: BotContext) => ctx.locale.admin.askUserUnblock,
  } as const;
  admin.action(/^a:in:(delete|block|unblock)$/, async (ctx) => {
    const action = ctx.match[1] as keyof typeof prompts;
    setState(ctx, { kind: 'admin_input', action });
    await answer(ctx);
    await respond(ctx, prompts[action](ctx), { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]) });
  });

  admin.on('message', adminInputRouter);

  bot.use(Composer.optional(isAdminUpdate, adminGuard, admin));
}
