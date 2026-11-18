import type { Composer } from 'telegraf';
import type { Message } from 'telegraf/types';
import { isDomainError } from '../../../lib/errors.js';
import { entitiesToHtml, stripCustomEmoji } from '../../../lib/entities-html.js';
import { classifyTelegramError } from '../../../lib/telegram-errors.js';
import { displayName, escapeHtml } from '../../../lib/format.js';
import { MAX_SPOTS_PER_BATTLE, type SpotWithDetails } from '../../../modules/final-spots/final-spot.service.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { extractMedia, prepareDraft, type MediaMessage } from '../submission.js';
import { PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

function spotLine(ctx: BotContext, spot: SpotWithDetails, index: number): string {
  const s = ctx.locale.admin.finalSpots;
  const who = escapeHtml([spot.user.firstName, spot.user.username ? `@${spot.user.username}` : ''].filter(Boolean).join(' '));
  const state = spot.refundedAt ? s.stateRefunded : spot.usedAt ? s.stateInFinal : spot.photoId ? s.statePhoto : s.stateNoPhoto;
  return `${index + 1}. ${who} — ${state}`;
}

/** "🎟 Places in the final": sale rules, who bought a place in the current battle, refunds. */
export async function showFinalSpots(ctx: BotContext): Promise<void> {
  const { rules, battle, offer, spots } = await ctx.deps.services.finalSpots.overview();
  const s = ctx.locale.admin.finalSpots;
  const sold = spots.filter((spot) => !spot.refundedAt).length;
  const lines = [s.title(rules), ''];
  if (battle) {
    lines.push(s.battleLine({ title: escapeHtml(battle.title), sold }));
    lines.push(offer.available ? s.saleOpen(offer.left) : s.saleClosed(ctx.locale.errors.FINAL_SPOT_UNAVAILABLE({ reason: offer.reason, fromRound: offer.fromRound ?? 0 })));
    if (spots.length > 0) lines.push('', ...spots.map((spot, index) => spotLine(ctx, spot, index)));
  } else {
    lines.push(s.noBattle);
  }
  lines.push('', s.hint);

  const refundable = spots.filter((spot) => !spot.refundedAt && !spot.usedAt);
  await respond(ctx, lines.join('\n'), {
    keyboard: inline([
      [button(s.grantButton, 'a:fs:grant')],
      [button(s.adButton, 'a:fs:ad')],
      [button(rules.enabled ? s.disable : s.enable, 'a:fs:tog')],
      [button(s.countButton(rules.count), 'a:fs:cnt'), button(s.priceButton(rules.price), 'a:fs:price')],
      ...refundable.map((spot) => [button(s.refundButton(spots.indexOf(spot) + 1), `a:fs:rf:${spot.id}`)]),
      [button(ctx.locale.admin.buttons.panel, PANEL)],
    ]),
  });
}

/** Text answer to "send the price": Stars for a place in the final. */
export async function handleFinalSpotPriceInput(ctx: BotContext, text: string): Promise<void> {
  const price = Number(text.trim());
  try {
    await ctx.deps.services.settings.update({ finalSpotPrice: price }, adminUserId(ctx));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    await ctx.reply(ctx.locale.admin.finalSpots.priceInvalid);
    return;
  }
  setState(ctx, undefined);
  await ctx.reply(ctx.locale.admin.finalSpots.priceSaved(price), { reply_markup: inline([[button(ctx.locale.admin.finalSpots.back, 'a:fs')]]) });
}

/** Text answer to "who gets a place": @username or id. */
export async function handleFinalSpotGrantInput(ctx: BotContext, text: string): Promise<void> {
  const s = ctx.locale.admin.finalSpots;
  const target = await ctx.deps.services.users.findByQuery(text.trim());
  if (!target) {
    await ctx.reply(s.userNotFound, { reply_markup: inline([[button(ctx.locale.common.cancel, 'a:fs')]]) });
    return;
  }
  setState(ctx, undefined);
  let spotId: number;
  try {
    spotId = (await ctx.deps.services.finalSpots.grantByAdmin(target, adminUserId(ctx))).spot.id;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    await ctx.reply(ctx.locale.errors[error.code](error.params), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
    return;
  }
  await ctx.reply(s.granted(escapeHtml(displayName(target))), {
    parse_mode: 'HTML',
    reply_markup: inline([[button(s.sendPhotoForHim, `a:fs:ph:${spotId}`)], [button(s.back, 'a:fs')]]),
  });
}

/** The admin's photo/video for a place they gave: it goes into the final right away. */
export async function handleSpotPhotoByAdmin(ctx: BotContext, message: Message, spotId: number): Promise<void> {
  const s = ctx.locale.admin.finalSpots;
  const media = 'photo' in message || 'video' in message || 'document' in message ? extractMedia(message as MediaMessage) : null;
  if (!media) {
    await ctx.reply(s.needPhoto, { reply_markup: inline([[button(ctx.locale.common.cancel, 'a:fs')]]) });
    return;
  }
  const { input, upload } = await prepareDraft(ctx, media);
  if (upload) {
    // Image files are re-uploaded as photos so they can go into the collage.
    const sent = await ctx.replyWithPhoto({ source: upload, filename: 'final.jpg' });
    input.fileId = sent.photo.at(-1)?.file_id ?? input.fileId;
  }
  setState(ctx, undefined);
  try {
    await ctx.deps.services.finalSpots.attachPhotoByAdmin(spotId, input);
  } catch (error) {
    if (!isDomainError(error)) throw error;
    await ctx.reply(ctx.locale.errors[error.code](error.params), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
    return;
  }
  await ctx.reply(s.photoAdded, { reply_markup: inline([[button(s.back, 'a:fs')]]) });
}

/**
 * The admin's message goes to the channel with a "Buy a place in the final" button
 * under it (a link that opens the purchase in the bot). Premium emoji cannot be
 * posted by a bot in a channel, so if Telegram refuses them the post goes out with regular ones.
 */
/**
 * The channel post the admin points at: their own post forwarded from the channel,
 * or its link (t.me/c/123/45 or t.me/channel/45). Null for a new message.
 */
export function channelPostId(message: Message, channel: { id: number; username?: string | undefined }): number | null {
  const origin = 'forward_origin' in message ? message.forward_origin : undefined;
  if (origin) {
    if (origin.type !== 'channel') return null;
    const sameChannel = origin.chat.id === channel.id || (!!channel.username && 'username' in origin.chat && origin.chat.username?.toLowerCase() === channel.username.replace(/^@/, '').toLowerCase());
    return sameChannel ? origin.message_id : null;
  }
  const text = 'text' in message ? message.text.trim() : '';
  const privateLink = /^(?:https?:\/\/)?t\.me\/c\/(\d+)\/(?:\d+\/)?(\d+)\/?(?:\?.*)?$/i.exec(text);
  if (privateLink && Number(`-100${privateLink[1]}`) === channel.id) return Number(privateLink[2]);
  const publicLink = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/(\d+)\/?(?:\?.*)?$/i.exec(text);
  if (publicLink && channel.username && publicLink[1]!.toLowerCase() === channel.username.replace(/^@/, '').toLowerCase()) return Number(publicLink[2]);
  return null;
}

function looksLikeChannelLink(message: Message): boolean {
  return ('forward_origin' in message && !!message.forward_origin) || ('text' in message && /^(?:https?:\/\/)?t\.me\/\S+\/\d+/i.test(message.text.trim()));
}

export async function handleFinalSpotAd(ctx: BotContext, message: Message): Promise<void> {
  const s = ctx.locale.admin.finalSpots;
  const { channel, gateway } = ctx.deps;
  const url = `https://t.me/${ctx.botInfo.username}?start=final`;
  const replyMarkup = { inline_keyboard: [[{ text: ctx.locale.finalSpot.adButton, url }]] };

  // The admin published the post in the channel themselves (premium emoji stay) — only the button is added.
  const postId = channelPostId(message, channel);
  if (postId === null && looksLikeChannelLink(message)) {
    await ctx.reply(s.adWrongChannel, { reply_markup: inline([[button(ctx.locale.common.cancel, 'a:fs')]]) });
    return;
  }
  setState(ctx, undefined);
  if (postId !== null) {
    try {
      await gateway.editMessageReplyMarkup(channel.id, postId, replyMarkup);
    } catch (error) {
      await ctx.reply(s.adAttachFailed(escapeHtml(classifyTelegramError(error).description)), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
      return;
    }
    await ctx.reply(s.adAttached, { reply_markup: inline([[button(s.back, 'a:fs')]]) });
    return;
  }

  let stripped = false;
  try {
    await gateway.copyMessage(channel.id, ctx.chat!.id, message.message_id, { replyMarkup });
  } catch (error) {
    const text = 'text' in message ? message.text : 'caption' in message ? message.caption : undefined;
    const entities = 'text' in message ? message.entities : 'caption_entities' in message ? message.caption_entities : undefined;
    const html = text ? stripCustomEmoji(entitiesToHtml(text, entities ?? [])) : '';
    try {
      if ('photo' in message) await gateway.sendPhoto(channel.id, message.photo.at(-1)!.file_id, { caption: html, parseMode: 'HTML', replyMarkup });
      else if (text) await gateway.sendMessage(channel.id, html, { parseMode: 'HTML', replyMarkup });
      else throw error;
      stripped = true;
    } catch {
      await ctx.reply(s.adFailed(escapeHtml(classifyTelegramError(error).description)), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
      return;
    }
  }
  await ctx.reply(stripped ? s.adPostedStripped : s.adPosted, { reply_markup: inline([[button(s.back, 'a:fs')]]) });
}

export function registerFinalSpotAdminHandlers(admin: Composer<BotContext>): void {
  admin.action('a:fs:ad', async (ctx) => {
    await answer(ctx);
    setState(ctx, { kind: 'admin_final_ad' });
    await respond(ctx, ctx.locale.admin.finalSpots.adAsk, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:fs')]]), forceNew: true });
  });

  admin.action(/^a:fs:ph:(\d+)$/, async (ctx) => {
    await answer(ctx);
    setState(ctx, { kind: 'admin_spot_photo', spotId: matchInt(ctx) });
    await respond(ctx, ctx.locale.admin.finalSpots.askPhoto, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:fs')]]), forceNew: true });
  });

  admin.action('a:fs:grant', async (ctx) => {
    await answer(ctx);
    setState(ctx, { kind: 'admin_input', action: 'final_spot_grant' });
    await respond(ctx, ctx.locale.admin.finalSpots.askGrant, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:fs')]]), forceNew: true });
  });

  admin.action('a:fs', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showFinalSpots(ctx);
  });

  admin.action('a:fs:tog', async (ctx) => {
    const { finalSpotsEnabled } = await ctx.deps.services.settings.get();
    await ctx.deps.services.settings.update({ finalSpotsEnabled: !finalSpotsEnabled }, adminUserId(ctx));
    await answer(ctx);
    await showFinalSpots(ctx);
  });

  // 1 ↔ 2 places per battle.
  admin.action('a:fs:cnt', async (ctx) => {
    const { finalSpotCount } = await ctx.deps.services.settings.get();
    const next = finalSpotCount >= MAX_SPOTS_PER_BATTLE ? 1 : finalSpotCount + 1;
    await ctx.deps.services.settings.update({ finalSpotCount: next }, adminUserId(ctx));
    await answer(ctx);
    await showFinalSpots(ctx);
  });

  admin.action('a:fs:price', async (ctx) => {
    await answer(ctx);
    setState(ctx, { kind: 'admin_input', action: 'final_spot_price' });
    await respond(ctx, ctx.locale.admin.finalSpots.askPrice, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:fs')]]), forceNew: true });
  });

  admin.action(/^a:fs:rf:(\d+)$/, async (ctx) => {
    await answer(ctx);
    const id = matchInt(ctx);
    await respond(ctx, ctx.locale.admin.finalSpots.refundConfirm, {
      keyboard: inline([[button(ctx.locale.common.yes, `a:fs:rfy:${id}`), button(ctx.locale.common.no, 'a:fs')]]),
    });
  });

  admin.action(/^a:fs:rfy:(\d+)$/, async (ctx) => {
    const done = await ctx.deps.services.finalSpots.refundByAdmin(matchInt(ctx), adminUserId(ctx));
    await answer(ctx, done ? ctx.locale.admin.finalSpots.refundDone : ctx.locale.common.alreadyProcessed, !done);
    await showFinalSpots(ctx);
  });
}
