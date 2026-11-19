import type { Telegraf } from 'telegraf';
import { allTranslations } from '../../i18n/index.js';
import { isDomainError } from '../../lib/errors.js';
import { escapeHtml, formatCardPrice } from '../../lib/format.js';
import { sendTransferOrder } from './payments.js';
import { parseFinalSpotPayload } from '../../modules/final-spots/final-spot.service.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, stripHtml } from '../helpers.js';
import { button, inline } from '../keyboards.js';

/** Is this Stars payload a place in the final (not a votes pack)? */
export function isFinalSpotPayload(payload: string): boolean {
  return parseFinalSpotPayload(payload) !== null;
}

/** "🎟 Buy a place in the final": explains the offer and sends the Stars invoice. */
export function registerFinalSpotHandlers(bot: Telegraf<BotContext>): void {
  bot.action('fs:buy', buyFinalSpot);
  bot.action('fs:t', payFinalSpotByTransfer);
  bot.command('final', buyFinalSpot);
  bot.hears(allTranslations((l) => l.menu.finalSpot), buyFinalSpot);
}

/** Explains the offer and sends the Stars invoice for a place in the final (or says why not now). */
export async function buyFinalSpot(ctx: BotContext): Promise<void> {
  {
    const user = currentUser(ctx);
    let invoice;
    try {
      invoice = await ctx.deps.services.finalSpots.createInvoice(user);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      const text = ctx.locale.errors[error.code](error.params);
      if (ctx.callbackQuery) await answer(ctx, stripHtml(text), true);
      else await ctx.reply(text, { parse_mode: 'HTML' });
      return;
    }
    if (ctx.callbackQuery) await answer(ctx);
    const offer = await ctx.deps.services.finalSpots.offer(user);
    const l = ctx.locale.finalSpot;
    const { payments, settings } = ctx.deps.services;
    const card = (await payments.spotTransferAvailable()) ? formatCardPrice((await settings.get()).finalSpotPriceCard, payments.options.cardCurrency) : null;
    await ctx.reply(l.offer({ price: invoice.amount, left: offer.available ? offer.left : 1, battle: escapeHtml(invoice.battle.title), card }), {
      parse_mode: 'HTML',
      ...(card ? { reply_markup: inline([[button(l.payCardButton(card), 'fs:t')]]) } : {}),
    });
    if (card) await ctx.reply(l.starsBelow);
    await ctx.replyWithInvoice({
      title: l.invoiceTitle,
      description: l.invoiceDescription(invoice.battle.title),
      payload: invoice.payload,
      provider_token: '',
      currency: invoice.currency,
      prices: [{ label: l.invoiceLabel, amount: invoice.amount }],
    });
  }
}

/** "💳 Pay 40 ₴ to the jar" for a place in the final: a transfer order with a code. */
async function payFinalSpotByTransfer(ctx: BotContext): Promise<void> {
  const user = currentUser(ctx);
  const offer = await ctx.deps.services.finalSpots.offer(user);
  if (!offer.available) {
    await answer(ctx, stripHtml(ctx.locale.errors.FINAL_SPOT_UNAVAILABLE({ reason: offer.reason, fromRound: offer.fromRound ?? 0 })), true);
    return;
  }
  let order;
  try {
    order = await ctx.deps.services.payments.createSpotTransfer(user, offer.battle.id);
  } catch (error) {
    if (!isDomainError(error)) throw error;
    await answer(ctx, stripHtml(ctx.locale.errors[error.code](error.params)), true);
    return;
  }
  await answer(ctx);
  await sendTransferOrder(ctx, order, true);
}

/** pre_checkout_query for a place in the final. */
export async function answerFinalSpotCheckout(ctx: BotContext): Promise<void> {
  const query = ctx.preCheckoutQuery!;
  const problem = await ctx.deps.services.finalSpots.validateCheckout({
    payload: query.invoice_payload,
    telegramUserId: query.from.id,
    currency: query.currency,
    totalAmount: query.total_amount,
  });
  if (!problem) {
    await ctx.answerPreCheckoutQuery(true);
    return;
  }
  const l = ctx.locale.payments;
  await ctx.answerPreCheckoutQuery(false, problem === 'unavailable' ? l.checkoutUnavailable : l.checkoutExpired);
}

/** successful_payment for a place in the final: ask for the photo, or say the Stars come back. */
export async function completeFinalSpot(ctx: BotContext, paid: { invoice_payload: string; telegram_payment_charge_id: string }): Promise<void> {
  const result = await ctx.deps.services.finalSpots.completePayment({
    payload: paid.invoice_payload,
    telegramUserId: ctx.from!.id,
    telegramChargeId: paid.telegram_payment_charge_id,
  });
  if (result.kind === 'duplicate') return;
  if (result.kind === 'refunded') {
    await ctx.reply(ctx.locale.finalSpot.soldOutRefunded);
    return;
  }
  await ctx.reply(ctx.locale.finalSpot.reserved, { parse_mode: 'HTML' });
}
