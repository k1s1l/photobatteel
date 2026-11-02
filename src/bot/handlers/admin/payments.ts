import type { Composer } from 'telegraf';
import type { VotePackage } from '../../../generated/prisma/client.js';
import { displayName, escapeHtml, formatDateTime, truncate } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import { formatCardPrice } from '../../../modules/payments/payment.service.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, clampPage, inline, paginationRow } from '../../keyboards.js';
import { backToPanel, PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const PAGE_SIZE = 10;
const PRICE_PATTERN = /^(\d{1,6})\s+(\d{1,7}(?:[.,]\d{1,2})?)$/;

function money(ctx: BotContext, amount: number): string {
  return formatCardPrice(amount, ctx.deps.services.payments.options.cardCurrency);
}

function packageInfo(ctx: BotContext, pack: VotePackage) {
  return { votes: pack.votes, stars: pack.priceStars, card: money(ctx, pack.priceCard), active: pack.isActive };
}

async function showPayments(ctx: BotContext): Promise<void> {
  const { payments, settings } = ctx.deps.services;
  const [stats, current, packs] = await Promise.all([payments.stats(), settings.get(), payments.listPackages(false)]);
  const a = ctx.locale.admin;
  const text = a.paymentsTitle({
    enabled: current.paidVotesEnabled,
    card: payments.options.cardEnabled,
    paid: stats.paid,
    paid24h: stats.paid24h,
    stars: stats.stars,
    cardTotal: money(ctx, stats.cardTotal),
    card24: money(ctx, stats.card24h),
    votesSold: stats.votesSold,
  });
  const rows = [
    [button(current.paidVotesEnabled ? a.paymentsToggleOff : a.paymentsToggleOn, 'a:pay:toggle')],
    ...packs.map((pack) => [button(a.packageRow(packageInfo(ctx, pack)), `a:pkg:${pack.id}`)]),
    [button(a.paymentsList, 'a:pay:list:0')],
    [button(a.buttons.panel, PANEL)],
  ];
  await respond(ctx, text, { keyboard: inline(rows) });
}

async function showPackage(ctx: BotContext, id: number): Promise<void> {
  const pack = await ctx.deps.services.payments.getPackage(id);
  const a = ctx.locale.admin;
  if (!pack) {
    await respond(ctx, ctx.locale.common.notFound, { keyboard: backToPanel(ctx.locale) });
    return;
  }
  await respond(ctx, a.packageCard(packageInfo(ctx, pack)), {
    keyboard: inline([
      [button(a.packageEditPrice, `a:pkg:e:${id}`)],
      [button(pack.isActive ? a.packageHide : a.packageShow, `a:pkg:t:${id}`)],
      [button(ctx.locale.common.back, 'a:pay')],
    ]),
  });
}

/** Text answer to "enter new price": "<stars> <card amount>", e.g. "90 89" or "90 89.50". */
export async function handlePackagePriceInput(ctx: BotContext, packageId: number, text: string): Promise<void> {
  const match = PRICE_PATTERN.exec(text.trim());
  if (!match?.[1] || !match[2]) {
    await ctx.reply(ctx.locale.admin.packagePriceInvalid, { parse_mode: 'HTML' });
    return;
  }
  const stars = Number(match[1]);
  const card = Math.round(Number(match[2].replace(',', '.')) * 100);
  try {
    await ctx.deps.services.payments.updatePackagePrice(packageId, stars, card, adminUserId(ctx));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    await ctx.reply(ctx.locale.admin.packagePriceInvalid, { parse_mode: 'HTML' });
    return;
  }
  setState(ctx, undefined);
  await ctx.reply(ctx.locale.admin.packageSaved, { reply_markup: inline([[button(ctx.locale.admin.buttons.payments, 'a:pay')]]) });
}

export function registerPaymentAdminHandlers(admin: Composer<BotContext>): void {
  admin.action('a:pay', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showPayments(ctx);
  });

  admin.action('a:pay:toggle', async (ctx) => {
    const { settings } = ctx.deps.services;
    const current = await settings.get();
    await settings.update({ paidVotesEnabled: !current.paidVotesEnabled }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.settingsSaved);
    await showPayments(ctx);
  });

  admin.action(/^a:pkg:(\d+)$/, async (ctx) => {
    await answer(ctx);
    await showPackage(ctx, matchInt(ctx));
  });

  admin.action(/^a:pkg:t:(\d+)$/, async (ctx) => {
    const id = matchInt(ctx);
    await ctx.deps.services.payments.togglePackage(id, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.packageSaved);
    await showPackage(ctx, id);
  });

  admin.action(/^a:pkg:e:(\d+)$/, async (ctx) => {
    const id = matchInt(ctx);
    const pack = await ctx.deps.services.payments.getPackage(id);
    await answer(ctx);
    if (!pack) return;
    setState(ctx, { kind: 'admin_input', action: 'package_price', packageId: id });
    await respond(ctx, ctx.locale.admin.askPackagePrice({ votes: pack.votes, currency: ctx.deps.services.payments.options.cardCurrency }), {
      keyboard: inline([[button(ctx.locale.common.cancel, 'a:pay')]]),
    });
  });

  admin.action(/^a:pay:list:(\d+)$/, async (ctx) => {
    const { payments } = ctx.deps.services;
    const requested = matchInt(ctx);
    let { items, total } = await payments.listPayments(requested, PAGE_SIZE);
    const page = clampPage(requested, total, PAGE_SIZE);
    if (page !== requested) ({ items, total } = await payments.listPayments(page, PAGE_SIZE));
    await answer(ctx);
    const a = ctx.locale.admin;
    const lines = [a.paymentsListTitle, ''];
    if (total === 0) lines.push(a.paymentsEmpty);
    for (const payment of items) {
      lines.push(
        a.paymentRow({
          id: payment.id,
          user: escapeHtml(truncate(displayName(payment.user), 24)),
          votes: payment.votes,
          amount: payment.method === 'STARS' ? `${payment.amount} ⭐` : money(ctx, payment.amount),
          status: a.paymentStatus[payment.status],
          date: payment.paidAt ? formatDateTime(payment.paidAt, ctx.deps.env.TIMEZONE, ctx.locale.intl) : '—',
        }),
      );
    }
    const rows = items.filter((p) => p.method === 'STARS' && p.status === 'PAID').map((p) => [button(a.refund(p.id), `a:pay:r:${p.id}`)]);
    rows.push(paginationRow(ctx.locale, page, total, PAGE_SIZE, (p) => `a:pay:list:${p}`));
    rows.push([button(ctx.locale.common.back, 'a:pay')]);
    await respond(ctx, lines.join('\n'), { keyboard: inline(rows) });
  });

  admin.action(/^a:pay:r:(\d+)$/, async (ctx) => {
    const id = matchInt(ctx);
    const payment = await ctx.deps.services.payments.getPayment(id);
    await answer(ctx);
    if (!payment) return;
    if (payment.method !== 'STARS') {
      await respond(ctx, ctx.locale.admin.refundOnlyStars, { keyboard: inline([[button(ctx.locale.common.back, 'a:pay:list:0')]]) });
      return;
    }
    await respond(ctx, ctx.locale.admin.refundConfirm({ id, amount: `${payment.amount} ⭐`, user: escapeHtml(displayName(payment.user)) }), {
      keyboard: inline([[button(ctx.locale.common.yes, `a:pay:ry:${id}`), button(ctx.locale.common.no, 'a:pay:list:0')]]),
    });
  });

  admin.action(/^a:pay:ry:(\d+)$/, async (ctx) => {
    const id = matchInt(ctx);
    const { payments, notifications } = ctx.deps.services;
    const done = await ctx.deps.locks.withLock(`refund:${id}`, 30_000, async () => {
      try {
        return await payments.refundStars(id, adminUserId(ctx));
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (done === null) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    const payment = await payments.getPayment(id);
    if (payment) await notifications.notifyUser(payment.user, (l) => l.payments.refunded(done.reclaimed));
    await respond(ctx, ctx.locale.admin.refundDone({ id, reclaimed: done.reclaimed }), {
      keyboard: inline([[button(ctx.locale.admin.paymentsList, 'a:pay:list:0'), button(ctx.locale.admin.buttons.panel, PANEL)]]),
    });
  });
}
