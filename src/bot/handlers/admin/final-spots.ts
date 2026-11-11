import type { Composer } from 'telegraf';
import { isDomainError } from '../../../lib/errors.js';
import { displayName, escapeHtml } from '../../../lib/format.js';
import { MAX_SPOTS_PER_BATTLE, type SpotWithDetails } from '../../../modules/final-spots/final-spot.service.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
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
  try {
    await ctx.deps.services.finalSpots.grantByAdmin(target, adminUserId(ctx));
  } catch (error) {
    if (!isDomainError(error)) throw error;
    await ctx.reply(ctx.locale.errors[error.code](error.params), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
    return;
  }
  await ctx.reply(s.granted(escapeHtml(displayName(target))), { parse_mode: 'HTML', reply_markup: inline([[button(s.back, 'a:fs')]]) });
}

export function registerFinalSpotAdminHandlers(admin: Composer<BotContext>): void {
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
