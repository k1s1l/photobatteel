import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { allTranslations } from '../../i18n/index.js';
import { formatCardPrice } from '../../modules/payments/payment.service.js';
import { currentUser, type BotContext } from '../context.js';
import { answer, matchInt, matchString } from '../helpers.js';
import { button, inline } from '../keyboards.js';

const SPEND_STEPS = [1, 5, 10] as const;

function packButtons(ctx: BotContext, target: number) {
  return async () => {
    const { payments } = ctx.deps.services;
    const packs = await payments.listPackages(true);
    return packs.map((pack) => {
      const row = [button(ctx.locale.payments.packStars({ votes: pack.votes, price: pack.priceStars }), `pay:s:${pack.id}:${target}`)];
      if (payments.options.cardEnabled) {
        const price = formatCardPrice(pack.priceCard, payments.options.cardCurrency);
        row.push(button(ctx.locale.payments.packCard({ votes: pack.votes, price }), `pay:c:${pack.id}:${target}`));
      }
      return row;
    });
  };
}

async function salesEnabled(ctx: BotContext): Promise<boolean> {
  if ((await ctx.deps.services.settings.get()).paidVotesEnabled) return true;
  await ctx.reply(ctx.locale.errors.PAYMENTS_DISABLED());
  return false;
}

/** General purchase menu: votes go to the balance. */
export async function showVotesMenu(ctx: BotContext): Promise<void> {
  if (!(await salesEnabled(ctx))) return;
  const rows = await packButtons(ctx, 0)();
  await ctx.reply(ctx.locale.payments.menu({ balance: currentUser(ctx).voteBalance }), { parse_mode: 'HTML', reply_markup: inline(rows) });
}

/** Opened from "⭐ +1" under a duel post: choose the entry to support. */
export async function showDuelSides(ctx: BotContext, duelId: number): Promise<void> {
  if (!(await salesEnabled(ctx))) return;
  const duel = await ctx.deps.services.battles.getDuel(duelId);
  if (duel?.status !== 'ACTIVE' || !duel.photoBId) {
    await ctx.reply(ctx.locale.errors.VOTING_CLOSED());
    return;
  }
  await ctx.reply(ctx.locale.duel.chooseSide({ round: duel.round, duel: duel.position }), {
    parse_mode: 'HTML',
    reply_markup: inline([[button(ctx.locale.duel.side(1), `pay:side:${duel.id}:a`), button(ctx.locale.duel.side(2), `pay:side:${duel.id}:b`)]]),
  });
}

export function registerPaymentHandlers(bot: Telegraf<BotContext>): void {
  bot.hears(allTranslations((l) => l.menu.votes), showVotesMenu);
  bot.command('votes', showVotesMenu);
  bot.command('paysupport', (ctx) => ctx.reply(ctx.locale.payments.support, { parse_mode: 'HTML' }));
  bot.command('terms', (ctx) => ctx.reply(ctx.locale.payments.terms, { parse_mode: 'HTML' }));

  bot.action(/^pay:side:(\d+):(a|b)$/, async (ctx) => {
    const duel = await ctx.deps.services.battles.getDuel(matchInt(ctx, 1));
    await answer(ctx);
    if (duel?.status !== 'ACTIVE' || !duel.photoBId) {
      await ctx.reply(ctx.locale.errors.VOTING_CLOSED());
      return;
    }
    const side = matchString(ctx, 2) === 'a' ? 1 : 2;
    const photoId = side === 1 ? duel.photoAId : duel.photoBId;
    const balance = currentUser(ctx).voteBalance;
    const rows = await packButtons(ctx, photoId)();
    const spend = SPEND_STEPS.filter((amount) => amount <= balance).map((amount) => button(ctx.locale.payments.spendButton(amount), `pay:spend:${photoId}:${amount}`));
    if (spend.length > 0) rows.unshift(spend);
    await ctx.reply(ctx.locale.payments.menuForSide({ side, round: duel.round, duel: duel.position, balance }), {
      parse_mode: 'HTML',
      reply_markup: inline(rows),
    });
  });

  bot.action(/^pay:spend:(\d+):(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx, 1);
    const amount = matchInt(ctx, 2);
    const user = currentUser(ctx);
    const result = await ctx.deps.locks.withLock(`spend:${user.id}`, 5_000, () => ctx.deps.services.payments.spendVotes(user, photoId, amount));
    if (!result) return answer(ctx, ctx.locale.common.busy);
    const active = await ctx.deps.services.battles.activeDuelOf(photoId);
    await answer(ctx);
    await ctx.reply(ctx.locale.payments.spent({ amount, side: active?.side ?? 1, left: result.balance }));
  });

  bot.action(/^pay:(s|c):(\d+):(\d+)$/, async (ctx) => {
    const method = matchString(ctx, 1) === 's' ? 'STARS' : 'CARD';
    const packageId = matchInt(ctx, 2);
    const photoId = matchInt(ctx, 3) || null;
    const invoice = await ctx.deps.services.payments.createInvoice(currentUser(ctx), packageId, method, photoId);
    const side = photoId ? ((await ctx.deps.services.battles.activeDuelOf(photoId))?.side ?? null) : null;
    await answer(ctx);
    const l = ctx.locale.payments;
    await ctx.replyWithInvoice({
      title: l.invoiceTitle(invoice.votes),
      description: side ? l.invoiceToSide({ votes: invoice.votes, side }) : l.invoiceToBalance(invoice.votes),
      payload: invoice.payload,
      // Stars invoices use an empty provider token; cards use the provider from @BotFather.
      provider_token: method === 'STARS' ? '' : (ctx.deps.env.PAYMENT_PROVIDER_TOKEN ?? ''),
      currency: invoice.currency,
      prices: [{ label: l.invoiceLabel(invoice.votes), amount: invoice.amount }],
    });
  });

  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const problem = await ctx.deps.services.payments.validateCheckout({
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
    const reason = problem === 'unavailable' ? l.checkoutUnavailable : problem === 'disabled' ? ctx.locale.errors.PAYMENTS_DISABLED() : l.checkoutExpired;
    await ctx.answerPreCheckoutQuery(false, reason);
  });

  bot.on(message('successful_payment'), async (ctx) => {
    const paid = ctx.message.successful_payment;
    const result = await ctx.deps.services.payments.completePayment({
      payload: paid.invoice_payload,
      telegramUserId: ctx.from.id,
      currency: paid.currency,
      totalAmount: paid.total_amount,
      telegramChargeId: paid.telegram_payment_charge_id,
      providerChargeId: paid.provider_payment_charge_id,
    });
    if (result.alreadyProcessed) return;
    const l = ctx.locale.payments;
    const votes = result.payment.votes;
    if (result.creditedTo === 'photo') await ctx.reply(l.paidToPhoto(votes));
    else if (result.targetUnavailable) await ctx.reply(l.paidPhotoGone({ votes, balance: result.balance }));
    else await ctx.reply(l.paidToBalance({ votes, balance: result.balance }));
  });
}
