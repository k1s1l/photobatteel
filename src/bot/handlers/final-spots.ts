import type { Telegraf } from 'telegraf';
import { isDomainError } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/format.js';
import { parseFinalSpotPayload } from '../../modules/final-spots/final-spot.service.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, stripHtml } from '../helpers.js';

/** Is this Stars payload a place in the final (not a votes pack)? */
export function isFinalSpotPayload(payload: string): boolean {
  return parseFinalSpotPayload(payload) !== null;
}

/** "🎟 Buy a place in the final": explains the offer and sends the Stars invoice. */
export function registerFinalSpotHandlers(bot: Telegraf<BotContext>): void {
  const buy = async (ctx: BotContext) => {
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
    await ctx.reply(l.offer({ price: invoice.amount, left: offer.available ? offer.left : 1, battle: escapeHtml(invoice.battle.title) }), { parse_mode: 'HTML' });
    await ctx.replyWithInvoice({
      title: l.invoiceTitle,
      description: l.invoiceDescription(invoice.battle.title),
      payload: invoice.payload,
      provider_token: '',
      currency: invoice.currency,
      prices: [{ label: l.invoiceLabel, amount: invoice.amount }],
    });
  };
  bot.action('fs:buy', buy);
  bot.command('final', buy);
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
