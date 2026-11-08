import type { Composer } from 'telegraf';
import type { Message } from 'telegraf/types';
import { entitiesToHtml, stripCustomEmoji, visibleLength } from '../../../lib/entities-html.js';
import { formatDateTime, formatTime } from '../../../lib/format.js';
import { activeDuelKeyboard } from '../../../modules/duels/duel-post.js';
import {
  isStagedKey,
  isStageVariant,
  isTemplateKey,
  renderTemplate,
  stageTemplateId,
  stageTemplates,
  stageValues,
  TEMPLATE_FIELDS,
  TEMPLATE_KEYS,
  TEMPLATE_PLACEHOLDERS,
  templateFor,
  type StagedKey,
  type StagePoint,
  type StageVariant,
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

/** A tournament moment that matches the per-round design being previewed. */
function samplePoint(variant?: StageVariant): StagePoint {
  if (variant === 'final') return { round: 4, entriesInRound: 2 };
  if (variant === 'final3') return { round: 3, entriesInRound: 3, finalSize: 3 };
  if (variant === 'final4') return { round: 3, entriesInRound: 4, finalSize: 4 };
  if (variant) return { round: Number(variant.slice(1)), entriesInRound: 16 };
  return { round: 1, entriesInRound: 8 };
}

/** Sample values so the admin sees a realistic preview. */
function sampleValues(ctx: BotContext, key: TemplateKey, variant?: StageVariant): Record<string, string | number> {
  const locale = ctx.deps.services.battles.channelLocale;
  const point = samplePoint(variant);
  const stageInfo = { ...point, duel: variant?.startsWith('final') ? 1 : 3, stage: 0 };
  const stage: Record<string, string | number> = { ...stageValues(locale, stageInfo), end: formatTime(new Date(Date.now() + 60 * 60_000), ctx.deps.env.TIMEZONE, locale.intl) };
  const start = formatDateTime(new Date(Date.now() + 60 * 60_000), ctx.deps.env.TIMEZONE, locale.intl);
  const samples: Record<TemplateKey, Record<string, string | number>> = {
    duel: { battle: 'Photo Battle', ...stage },
    announce: { battle: 'Photo Battle', start, bot: `@${ctx.botInfo.username}` },
    round: variant
      ? { battle: 'Photo Battle', round: point.round, roundName: stage.roundName!, entries: point.entriesInRound, end: stage.end! }
      : { battle: 'Photo Battle', round: 3, roundName: locale.duel.roundNames.final, entries: 2, end: stage.end! },
    winner: { battle: 'Photo Battle', votes: 57 },
    buttons: stage,
  };
  return samples[key];
}

/** Preview vote counts: 2 buttons, or 3–4 for a group final design. */
function sampleVotes(variant?: StageVariant): { side: 'A' | 'B' | 'C' | 'D'; votes: number }[] {
  const all = [
    { side: 'A' as const, votes: 12 },
    { side: 'B' as const, votes: 9 },
    { side: 'C' as const, votes: 7 },
    { side: 'D' as const, votes: 4 },
  ];
  return all.slice(0, variant === 'final3' ? 3 : variant === 'final4' ? 4 : 2);
}

async function sendPreview(ctx: BotContext, key: TemplateKey, template: string, variant?: StageVariant): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const html = renderTemplate(template, key, sampleValues(ctx, key, variant));
  const locale = ctx.deps.services.battles.channelLocale;
  // Preview buttons are inert: they point at a duel that does not exist.
  const keyboard = key === 'duel' || key === 'buttons' ? activeDuelKeyboard(locale, { id: 0, stage: 0, votes: sampleVotes(variant) }, settings.paidVotesEnabled) : undefined;
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
  const text = a.designType({ name: a.templateNames[key], custom, placeholders: placeholdersList(key) }) + (isStagedKey(key) ? `\n\n${a.designRoundsHint}` : '');
  await respond(ctx, text, {
    keyboard: inline([
      ...(isStagedKey(key) ? stageRows(ctx, key, stageTemplates(settings)) : []),
      [button(a.designUpload, `a:tpl:up:${key}`)],
      ...(custom ? [[button(a.designReset, `a:tpl:reset:${key}`)]] : []),
      [button(ctx.locale.common.back, 'a:tpl')],
    ]),
  });
  await sendPreview(ctx, key, templateFor(settings, ctx.deps.services.battles.channelLocale, key));
}

/** Buttons "Раунд 1 … Раунд 4, Фінал"; ✏️ marks the ones with their own design. */
function stageRows(ctx: BotContext, key: StagedKey, saved: Record<string, string>): ReturnType<typeof button>[][] {
  const label = (variant: StageVariant): string => `${saved[stageTemplateId(key, variant)] ? '✏️ ' : ''}${ctx.locale.admin.stageNames[variant]}`;
  const item = (variant: StageVariant) => button(label(variant), `a:tpl:v:${key}:${variant}`);
  return [[item('r1'), item('r2')], [item('r3'), item('r4')], [item('final')], [item('final3'), item('final4')]];
}

async function showVariant(ctx: BotContext, key: StagedKey, variant: StageVariant): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const own = stageTemplates(settings)[stageTemplateId(key, variant)];
  const a = ctx.locale.admin;
  await respond(ctx, a.designVariant({ name: a.templateNames[key], stage: a.stageNames[variant], custom: !!own, placeholders: placeholdersList(key) }), {
    keyboard: inline([
      [button(a.designUpload, `a:tpl:up:${key}:${variant}`)],
      ...(own ? [[button(a.designReset, `a:tpl:reset:${key}:${variant}`)]] : []),
      [button(ctx.locale.common.back, `a:tpl:k:${key}`)],
    ]),
  });
  const template = own ?? templateFor(settings, ctx.deps.services.battles.channelLocale, key);
  await sendPreview(ctx, key, template, variant);
}

/** "duel:final" from a callback → a valid per-round target, or null. */
function parseStageTarget(key: string, variant: string | undefined): { key: StagedKey; variant: StageVariant } | null {
  return variant !== undefined && isStagedKey(key) && isStageVariant(variant) ? { key, variant } : null;
}

/** The admin's designed message (text or caption, with entities) becomes the template. */
export async function handleTemplateMessage(ctx: BotContext, message: Message, key: TemplateKey, variant?: StageVariant): Promise<void> {
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
  const target = parseStageTarget(key, variant);
  if (target) await ctx.deps.services.settings.setStageTemplate(target.key, target.variant, html, adminUserId(ctx));
  else await ctx.deps.services.settings.update({ [TEMPLATE_FIELDS[key]]: html }, adminUserId(ctx));
  await ctx.reply(ctx.locale.admin.designSaved);
  await sendPreview(ctx, key, html, target?.variant);
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

  admin.action(/^a:tpl:v:(\w+):(\w+)$/, async (ctx) => {
    const target = parseStageTarget(matchString(ctx), matchString(ctx, 2));
    await answer(ctx);
    if (target) await showVariant(ctx, target.key, target.variant);
  });

  admin.action(/^a:tpl:up:(\w+)(?::(\w+))?$/, async (ctx) => {
    const key = matchString(ctx);
    const variantRaw = (ctx as BotContext & { match?: RegExpExecArray }).match?.[2];
    await answer(ctx);
    if (!isTemplateKey(key)) return;
    const target = parseStageTarget(key, variantRaw);
    if (variantRaw !== undefined && !target) return;
    setState(ctx, { kind: 'admin_template', key, ...(target ? { variant: target.variant } : {}) });
    await respond(ctx, ctx.locale.admin.designAsk(placeholdersList(key)), { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]), forceNew: true });
  });

  admin.action(/^a:tpl:reset:(\w+):(\w+)$/, async (ctx) => {
    const target = parseStageTarget(matchString(ctx), matchString(ctx, 2));
    if (!target) return answer(ctx);
    await ctx.deps.services.settings.setStageTemplate(target.key, target.variant, null, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.designResetDone);
    await showVariant(ctx, target.key, target.variant);
  });

  admin.action(/^a:tpl:reset:(\w+)$/, async (ctx) => {
    const key = matchString(ctx);
    if (!isTemplateKey(key)) return answer(ctx);
    await ctx.deps.services.settings.update({ [TEMPLATE_FIELDS[key]]: null }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.designResetDone);
    await showTemplate(ctx, key);
  });
}
