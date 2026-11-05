import type { Composer } from 'telegraf';
import type { Message } from 'telegraf/types';
import { entitiesToHtml, stripCustomEmoji, visibleLength } from '../../../lib/entities-html.js';
import { activeDuelKeyboard, renderDuelCaption } from '../../../modules/duels/duel-post.js';
import { MAX_TEMPLATE_LENGTH } from '../../../modules/settings/settings.service.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

/** Telegram allows 1024 characters in a photo caption; keep room for placeholder values. */
const MAX_VISIBLE_CAPTION = 900;

async function sendPreview(ctx: BotContext, template: string): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const caption = renderDuelCaption(template, ctx.deps.services.battles.channelLocale, { battleTitle: 'Photo Battle', round: 1, position: 3, stage: 0 });
  const keyboard = activeDuelKeyboard(ctx.deps.services.battles.channelLocale, { id: 0, stage: 0, votesA: 12, votesB: 9 }, settings.paidVotesEnabled);
  // Preview buttons are inert: they point at a duel that does not exist.
  try {
    await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    // Premium emoji need the bot owner's Telegram Premium even in private chats.
    await ctx.reply(stripCustomEmoji(caption), { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

async function showDesign(ctx: BotContext): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const a = ctx.locale.admin;
  await respond(ctx, a.designTitle(!!settings.duelTemplate), {
    keyboard: inline([
      [button(a.designUpload, 'a:tpl:up')],
      ...(settings.duelTemplate ? [[button(a.designReset, 'a:tpl:reset')]] : []),
      [button(a.buttons.panel, PANEL)],
    ]),
  });
  await sendPreview(ctx, settings.duelTemplate ?? ctx.deps.services.battles.channelLocale.duel.defaultTemplate);
}

/** The admin's designed message (text or caption, with entities) becomes the duel template. */
export async function handleTemplateMessage(ctx: BotContext, message: Message): Promise<void> {
  const text = 'text' in message ? message.text : 'caption' in message ? message.caption : undefined;
  const entities = 'text' in message ? message.entities : 'caption_entities' in message ? message.caption_entities : undefined;
  if (!text) {
    await ctx.reply(ctx.locale.admin.designNeedsText);
    return;
  }
  const html = entitiesToHtml(text, entities ?? []);
  if (html.length > MAX_TEMPLATE_LENGTH || visibleLength(html) > MAX_VISIBLE_CAPTION) {
    await ctx.reply(ctx.locale.admin.textTooLong(MAX_VISIBLE_CAPTION));
    return;
  }
  setState(ctx, undefined);
  await ctx.deps.services.settings.update({ duelTemplate: html }, adminUserId(ctx));
  await ctx.reply(ctx.locale.admin.designSaved);
  await sendPreview(ctx, html);
}

export function registerDesignHandlers(admin: Composer<BotContext>): void {
  admin.action('a:tpl', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showDesign(ctx);
  });

  admin.action('a:tpl:up', async (ctx) => {
    setState(ctx, { kind: 'admin_template' });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.designAsk, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]), forceNew: true });
  });

  admin.action('a:tpl:reset', async (ctx) => {
    await ctx.deps.services.settings.update({ duelTemplate: null }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.designResetDone);
    await showDesign(ctx);
  });
}
