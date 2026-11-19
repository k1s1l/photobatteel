import type { Composer } from 'telegraf';
import { escapeHtml } from '../../../lib/format.js';
import { formatPerVote } from '../../../modules/battles/prize.js';
import type { BotContext } from '../../context.js';
import { setState } from '../../context.js';
import { answer, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { adminUserId } from './shared.js';

type PrizeInput = 'prize_base' | 'prize_threshold' | 'prize_rate';

/** "💰 Prize fund": the growing prize rules and where the current battle stands. */
export async function showPrize(ctx: BotContext): Promise<void> {
  const settings = await ctx.deps.services.settings.get();
  const p = ctx.locale.admin.prize;
  const current = await ctx.deps.services.battles.getCurrent();
  const battle = current?.status === 'RUNNING' ? current : null;
  const state = battle && settings.prizeEnabled ? await ctx.deps.services.battles.prizeState(battle.id) : null;
  const perVote = formatPerVote(settings.prizePerHundred);
  const text = p.screen({
    enabled: settings.prizeEnabled,
    base: settings.prizeBase,
    threshold: settings.prizeThreshold,
    perVote,
    current: battle && state ? p.current({ battle: escapeHtml(battle.title), paid: state.paidVotes, stars: state.stars, left: state.left }) : null,
  });
  await respond(ctx, text, {
    keyboard: inline([
      [button(settings.prizeEnabled ? p.disable : p.enable, 'a:pz:tog')],
      [button(p.baseButton(settings.prizeBase), 'a:pz:in:prize_base')],
      [button(p.thresholdButton(settings.prizeThreshold), 'a:pz:in:prize_threshold')],
      [button(p.rateButton(perVote), 'a:pz:in:prize_rate')],
      [button(ctx.locale.common.back, 'a:bt')],
    ]),
  });
}

/** Text answer for one of the prize numbers. */
export async function handlePrizeInput(ctx: BotContext, action: PrizeInput, text: string): Promise<void> {
  const p = ctx.locale.admin.prize;
  const value = Number(text.trim().replace(',', '.').replace(/\s*(⭐|звёзд|звезд|зірок)$/i, ''));
  const patch =
    action === 'prize_base'
      ? { prizeBase: value }
      : action === 'prize_threshold'
        ? { prizeThreshold: value }
        : { prizePerHundred: Math.round(value * 100) };
  try {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid prize value');
    await ctx.deps.services.settings.update(patch, adminUserId(ctx));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    await ctx.reply(p.invalid);
    return;
  }
  setState(ctx, undefined);
  await ctx.reply(p.saved);
  await showPrize(ctx);
}

export function registerPrizeHandlers(admin: Composer<BotContext>): void {
  admin.action('a:pz', async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showPrize(ctx);
  });

  admin.action('a:pz:tog', async (ctx) => {
    const { settings } = ctx.deps.services;
    const current = await settings.get();
    await settings.update({ prizeEnabled: !current.prizeEnabled }, adminUserId(ctx));
    await answer(ctx, ctx.locale.admin.prize.saved);
    await showPrize(ctx);
  });

  admin.action(/^a:pz:in:(prize_base|prize_threshold|prize_rate)$/, async (ctx) => {
    const action = (ctx as BotContext & { match?: RegExpExecArray }).match![1] as PrizeInput;
    const p = ctx.locale.admin.prize;
    setState(ctx, { kind: 'admin_input', action });
    await answer(ctx);
    const ask = action === 'prize_base' ? p.askBase : action === 'prize_threshold' ? p.askThreshold : p.askRate;
    await respond(ctx, ask, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:pz')]]), forceNew: true });
  });
}
