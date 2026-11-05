import type { Composer } from 'telegraf';
import type { Message } from 'telegraf/types';
import { entitiesToHtml, stripCustomEmoji, visibleLength } from '../../../lib/entities-html.js';
import { formatDateTime } from '../../../lib/format.js';
import { activeDuelKeyboard } from '../../../modules/duels/duel-post.js';
import {
  isTemplateKey,
  renderTemplate,
  stageValues,
  TEMPLATE_FIELDS,
  TEMPLATE_KEYS,
  TEMPLATE_PLACEHOLDERS,
  templateFor,
  type TemplateKey,
} from '../../../modules/duels/templates.js';
import { MAX_TEMPLATE_LENGTH } from '../../../modules/settings/settings.service.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchString, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

/** Telegram allows 1024 characters in a photo caption; keep room for placeholder values. */
const MAX_VISIBLE_CAPTION = 900;

function placeholdersList(key: TemplateKey): string {
  return TEMPLATE_PLACEHOLDERS[key].map((name) => `<code>{${name}}</code>`).join(', ');
}

/** Sample values so the admin sees a realistic preview. */
function sampleValues(ctx: BotContext, key: TemplateKey): Record<string, string | number> {
  const locale = ctx.deps.services.battles.channelLocale;
  const stage = stageValues(locale, { round: 1, entriesInRound: 8, duel: 3, stage: 0 });
  const start = formatDateTime(new Date(Date.now() + 60 * 60_000), ctx.deps.env.TIMEZONE, locale.intl);
  const samples: Record<TemplateKey, Record<string, string | number>> = {
    duel: { battle: 'Photo Battle', ...stage },
    announce: { battle: 'Photo Battle', start, bot: `@${ctx.botInfo.username}` },
    round: { battle: 'Photo Battle', round: 3, roundName: locale.duel.roundNames.final, entries: 2 },
    winner: { battle: 'Photo Battle', votes: 57 },
    buttons: stage,
  };
  return samples[key];
}

async function sendPreview(ctx: BotContext, key: TemplateKey, template: string): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const html = renderTemplate(template, key, sampleValues(ctx, key));
  const locale = ctx.deps.services.battles.channelLocale;
  // Preview buttons are inert: they point at a duel that does not exist.
  const keyboard = key === 'duel' || key === 'buttons' ? activeDuelKeyboard(locale, { id: 0, stage: 0, votesA: 12, votesB: 9 }, settings.paidVotesEnabled) : undefined;
  const extra = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
  try {
    await ctx.reply(html, extra);
  } catch {
    // Premium emoji in a bot's message need the bot owner's Telegram Premium.
    await ctx.reply(stripCustomEmoji(html), extra);
  }
}

async function showMenu(ctx: BotContext): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const names = ctx.locale.admin.templateNames;
  await respond(ctx, ctx.locale.admin.designMenu, {
    keyboard: inline([
      ...TEMPLATE_KEYS.map((key) => [button(`${settings[TEMPLATE_FIELDS[key]] ? '✏️ ' : ''}${names[key]}`, `a:tpl:k:${key}`)]),
      [button(ctx.locale.admin.buttons.panel, PANEL)],
    ]),
  });
}

async function showTemplate(ctx: BotContext, key: TemplateKey): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const custom = !!settings[TEMPLATE_FIELDS[key]];
  const a = ctx.locale.admin;
  await respond(ctx, a.designType({ name: a.templateNames[key], custom, placeholders: placeholdersList(key) }), {
    keyboard: inline([
      [button(a.designUpload, `a:tpl:up:${key}`)],
      ...(custom ? [[button(a.designReset, `a:tpl:reset:${key}`)]] : []),
      [button(ctx.locale.common.back, 'a:tpl')],
    ]),
  });
  await sendPreview(ctx, key, templateFor(settings, ctx.deps.services.battles.channelLocale, key));
}

/** The admin's designed message (text or caption, with entities) becomes the template. */
export async function handleTemplateMessage(ctx: BotContext, message: Message, key: TemplateKey): Promise<void> {
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
  await ctx.deps.services.settings.update({ [TEMPLATE_FIELDS[key]]: html }, adminUserId(ctx));
  await ctx.reply(ctx.locale.admin.designSaved);
  await sendPreview(ctx, key, html);
}

export function registerDesignHandlers(admin: Composer<BotContext>): void {
  admin.action('a:tpl', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showMenu(ctx);
  });

  admin.action(/^a:tpl:k:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    await answer(ctx);
    if (isTemplateKey(key)) await showTemplate(ctx, key);
  });

  admin.action(/^a:tpl:up:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    await answer(ctx);
    if (!isTemplateKey(key)) return;
    setState(ctx, { kind: 'admin_template', key });
    await respond(ctx, ctx.locale.admin.designAsk(placeholdersList(key)), { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]), forceNew: true });
  });

  admin.action(/^a:tpl:reset:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    if (!isTemplateKey(key)) return answer(ctx);
    await ctx.deps.services.settings.update({ [TEMPLATE_FIELDS[key]]: null }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.designResetDone);
    await showTemplate(ctx, key);
  });
}
