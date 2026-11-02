import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { allTranslations } from '../../i18n/index.js';
import { isDomainError } from '../../lib/errors.js';
import { formatPhotoId, parsePhotoId } from '../../lib/format.js';
import { formatCardPrice } from '../../modules/payments/payment.service.js';
import { currentUser, getState, setState, type BotContext } from '../context.js';
import { answer, matchInt, matchString, stripHtml } from '../helpers.js';
import { button, inline } from '../keyboards.js';

const BOOST_LOCK_MS = 2_000;
const GIVE_PATTERN = /^#?\s*(\d{1,9})\s+(\d{1,5})$/;

/** Packs with "⭐ Stars" and (if configured) "💳 card" buttons; optional target photo. */
export async function showVotesMenu(ctx: BotContext, targetPhotoId: number | null): Promise<void> {
  const { payments, settings } = ctx.deps.services;
  if (!(await settings.get()).paidVotesEnabled) {
    await ctx.reply(ctx.locale.errors.PAYMENTS_DISABLED());
    return;
  }
  const user = currentUser(ctx);
  const packs = await payments.listPackages(true);
  const target = targetPhotoId ?? 0;
  const rows = packs.map((pack) => {
    const row = [button(ctx.locale.payments.packStars({ votes: pack.votes, price: pack.priceStars }), `pay:s:${pack.id}:${target}`)];
    if (payments.options.cardEnabled) {
      const price = formatCardPrice(pack.priceCard, payments.options.cardCurrency);
      row.push(button(ctx.locale.payments.packCard({ votes: pack.votes, price }), `pay:c:${pack.id}:${target}`));
    }
    return row;
  });
  if (!targetPhotoId && user.voteBalance > 0) rows.push([button(ctx.locale.payments.give, 'pay:give')]);
  const text = targetPhotoId ? ctx.locale.payments.menuForPhoto(formatPhotoId(targetPhotoId)) : ctx.locale.payments.menu({ balance: user.voteBalance });
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: inline(rows) });
}

async function giveVotes(ctx: BotContext, photoId: number, amount: number): Promise<void> {
  const result = await ctx.deps.services.payments.spendVotes(currentUser(ctx), photoId, amount);
  await ctx.reply(ctx.locale.payments.given({ amount, id: formatPhotoId(photoId), left: result.balance }));
}

export function registerPaymentHandlers(bot: Telegraf<BotContext>): void {
  bot.hears(allTranslations((l) => l.menu.votes), (ctx) => showVotesMenu(ctx, null));
  bot.command('votes', (ctx) => showVotesMenu(ctx, null));
  bot.command('paysupport', (ctx) => ctx.reply(ctx.locale.payments.support, { parse_mode: 'HTML' }));
  bot.command('terms', (ctx) => ctx.reply(ctx.locale.payments.terms, { parse_mode: 'HTML' }));

  bot.action(/^pay:(s|c):(\d+):(\d+)$/, async (ctx) => {
    const method = matchString(ctx, 1) === 's' ? 'STARS' : 'CARD';
    const packageId = matchInt(ctx, 2);
    const photoId = matchInt(ctx, 3) || null;
    const { payments } = ctx.deps.services;
    const invoice = await payments.createInvoice(currentUser(ctx), packageId, method, photoId);
    await answer(ctx);
    const l = ctx.locale.payments;
    await ctx.replyWithInvoice({
      title: l.invoiceTitle(invoice.votes),
      description: photoId ? l.invoiceToPhoto({ votes: invoice.votes, id: formatPhotoId(photoId) }) : l.invoiceToBalance(invoice.votes),
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
    if (result.creditedTo === 'photo' && result.payment.targetPhotoId) {
      await ctx.reply(l.paidToPhoto({ votes, id: formatPhotoId(result.payment.targetPhotoId) }));
    } else if (result.targetUnavailable) {
      await ctx.reply(l.paidPhotoGone({ votes, balance: result.balance }));
    } else {
      await ctx.reply(l.paidToBalance({ votes, balance: result.balance }));
    }
  });

  // "⭐ +1 vote" under a channel post: spends one purchased vote, or opens the purchase in the bot.
  bot.action(/^b:(\d+)$/, async (ctx) => {
    const photoId = matchInt(ctx);
    const user = currentUser(ctx);
    try {
      const result = await ctx.deps.locks.withLock(`boost:${user.id}`, BOOST_LOCK_MS, () => ctx.deps.services.payments.spendVotes(user, photoId, 1));
      if (!result) return answer(ctx, ctx.locale.common.busy);
      await answer(ctx, ctx.locale.vote.boosted(result.balance));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === 'INSUFFICIENT_BALANCE') {
        try {
          await ctx.answerCbQuery(ctx.locale.vote.noBalance, { url: `https://t.me/${ctx.botInfo.username}?start=boost_${photoId}` });
        } catch {
          await answer(ctx, ctx.locale.vote.noBalance, true);
        }
        return;
      }
      const text = error.code === 'NOT_FOUND' ? ctx.locale.vote.unavailable : stripHtml(ctx.locale.errors[error.code](error.params));
      await answer(ctx, text, true);
    }
  });

  bot.action('pay:give', async (ctx) => {
    setState(ctx, { kind: 'give_votes' });
    await answer(ctx);
    await ctx.reply(ctx.locale.payments.askGive, { parse_mode: 'HTML', reply_markup: inline([[button(ctx.locale.common.cancel, 'sub:cancel')]]) });
  });

  bot.on(message('text'), async (ctx, next) => {
    if (getState(ctx)?.kind !== 'give_votes' || ctx.message.text.startsWith('/')) return next();
    const match = GIVE_PATTERN.exec(ctx.message.text.trim());
    const photoId = match?.[1] ? parsePhotoId(match[1]) : null;
    const amount = Number(match?.[2]);
    if (!photoId || !Number.isInteger(amount) || amount < 1) {
      // A menu button pressed instead of an answer: leave the dialog.
      if (!match && !/\d/.test(ctx.message.text)) {
        setState(ctx, undefined);
        return next();
      }
      await ctx.reply(ctx.locale.payments.giveInvalid, { parse_mode: 'HTML' });
      return;
    }
    setState(ctx, undefined);
    await giveVotes(ctx, photoId, amount);
  });
}
