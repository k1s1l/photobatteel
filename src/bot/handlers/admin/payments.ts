import type { Composer } from 'telegraf';
import type { VotePackage } from '../../../generated/prisma/client.js';
import { displayName, escapeHtml, formatDateTime, truncate } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import { formatCardPrice } from '../../../modules/payments/payment.service.js';
import type { BotContext } from '../../context.js';
import { getState, setState } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
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
  const bank = !payments.bank ? 'off' : current.monobankAccountId ? 'on' : 'no-account';
  const transfer = a.transferStatus({ enabled: current.transferEnabled, details: current.transferDetails ? escapeHtml(current.transferDetails) : null, bank });
  const rows = [
    [button(current.paidVotesEnabled ? a.paymentsToggleOff : a.paymentsToggleOn, 'a:pay:toggle')],
    ...packs.map((pack) => [button(a.packageRow(packageInfo(ctx, pack)), `a:pkg:${pack.id}`)]),
    [button(current.transferEnabled ? a.transferToggleOff : a.transferToggleOn, 'a:pay:tr:toggle')],
    [button(a.transferDetailsButton, 'a:pay:tr:details'), button(a.monobankButton, 'a:pay:mono')],
    [button(a.transfersButton, 'a:pay:trl'), button(a.paymentsList, 'a:pay:list:0')],
    [button(a.buttons.panel, PANEL)],
  ];
  await respond(ctx, text + transfer, { keyboard: inline(rows) });
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

const TRANSFER_DETAILS_MAX = 200;

/** Text answer to "send transfer details": the card number or jar link buyers will see. */
export async function handleTransferDetailsInput(ctx: BotContext, text: string): Promise<void> {
  const details = text.trim();
  if (!details || details.length > TRANSFER_DETAILS_MAX) {
    await ctx.reply(ctx.locale.admin.textTooLong(TRANSFER_DETAILS_MAX));
    return;
  }
  setState(ctx, undefined);
  await ctx.deps.services.settings.update({ transferDetails: details }, adminUserId(ctx));
  await ctx.reply(ctx.locale.admin.transferDetailsSaved, { reply_markup: inline([[button(ctx.locale.admin.buttons.payments, 'a:pay')]]) });
}

async function showTransfers(ctx: BotContext): Promise<void> {
  const a = ctx.locale.admin;
  const open = await ctx.deps.services.payments.openTransfers(15);
  const lines = [a.transfersTitle, ''];
  if (open.length === 0) lines.push(a.transfersEmpty);
  for (const payment of open) {
    lines.push(
      a.transferRow({
        id: payment.id,
        code: payment.code ?? '',
        amount: money(ctx, payment.amount),
        votes: payment.votes,
        buyer: escapeHtml(truncate(displayName(payment.user), 24)),
        status: a.paymentStatus[payment.status],
      }),
    );
  }
  const rows = open.map((payment) => [button(`✅ #${payment.id}`, `a:tr:ok:${payment.id}`), button(`❌ #${payment.id}`, `a:tr:no:${payment.id}`)]);
  rows.push([button(ctx.locale.common.back, 'a:pay')]);
  await respond(ctx, lines.join('\n'), { keyboard: inline(rows) });
}

export function registerPaymentAdminHandlers(admin: Composer<BotContext>): void {
  admin.action('a:pay:tr:toggle', async (ctx) => {
    const { settings } = ctx.deps.services;
    const current = await settings.get();
    await settings.update({ transferEnabled: !current.transferEnabled }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.settingsSaved);
    await showPayments(ctx);
  });

  admin.action('a:pay:tr:details', async (ctx) => {
    setState(ctx, { kind: 'admin_input', action: 'transfer_details' });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.askTransferDetails, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:pay')]]) });
  });

  admin.action('a:pay:mono', async (ctx) => {
    const { payments } = ctx.deps.services;
    await answer(ctx);
    const back = inline([[button(ctx.locale.common.back, 'a:pay')]]);
    if (!payments.bank) return respond(ctx, ctx.locale.admin.monobankNoToken, { keyboard: back });
    let accounts;
    try {
      accounts = await payments.bank.listAccounts();
    } catch (error) {
      ctx.deps.logger.warn({ err: error }, 'Monobank client-info failed');
      return respond(ctx, ctx.locale.admin.monobankError, { keyboard: back });
    }
    setState(ctx, { kind: 'monobank_pick', accounts: accounts.map((acc) => ({ id: acc.id, label: acc.label, ...(acc.sendLink ? { sendLink: acc.sendLink } : {}) })) });
    await respond(ctx, ctx.locale.admin.monobankChoose, {
      keyboard: inline([...accounts.map((acc, index) => [button(`${acc.kind === 'jar' ? '🫙' : '💳'} ${acc.label}`, `a:pay:mono:${index}`)]), [button(ctx.locale.common.back, 'a:pay')]]),
    });
  });

  admin.action(/^a:pay:mono:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const chosen = state?.kind === 'monobank_pick' ? state.accounts[matchInt(ctx)] : undefined;
    if (!chosen) return answer(ctx, ctx.locale.common.alreadyProcessed);
    setState(ctx, undefined);
    const current = await ctx.deps.services.settings.get();
    // A jar has a public top-up link: use it as the transfer details unless the admin set their own.
    await ctx.deps.services.settings.update(
      { monobankAccountId: chosen.id, ...(chosen.sendLink && !current.transferDetails ? { transferDetails: chosen.sendLink } : {}) },
      adminUserId(ctx),
    );
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.monobankSaved(escapeHtml(chosen.label)), { keyboard: inline([[button(ctx.locale.admin.buttons.payments, 'a:pay')]]) });
  });

  admin.action('a:pay:trl', async (ctx) => {
    await answer(ctx);
    await showTransfers(ctx);
  });

  admin.action(/^a:tr:(ok|no):(\d+)$/, async (ctx) => {
    const approve = matchString(ctx, 1) === 'ok';
    const id = matchInt(ctx, 2);
    const done = await ctx.deps.locks.withLock(`transfer:${id}`, 15_000, async () => {
      try {
        return await ctx.deps.services.payments.reviewTransfer(id, adminUserId(ctx), approve);
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (done === null) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    await respond(ctx, approve ? ctx.locale.admin.transferApproved(id) : ctx.locale.admin.transferDeclined(id), {
      keyboard: inline([[button(ctx.locale.admin.transfersButton, 'a:pay:trl'), button(ctx.locale.admin.buttons.payments, 'a:pay')]]),
    });
  });

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
