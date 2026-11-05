import type { Composer } from 'telegraf';
import { escapeHtml, formatDateTime } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import { parseStartTime } from '../../../lib/time.js';
import type { BotContext } from '../../context.js';
import { getState, setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { battleStatusLabel } from '../profile.js';
import { backToPanel, PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const ROUND_MINUTES = [15, 30, 60, 120, 180, 360, 720, 1440] as const;
const RECENT_BATTLES = 5;
const TITLE_MAX = 64;

async function showBattles(ctx: BotContext): Promise<void> {
  const { battles } = ctx.deps.services;
  const list = await battles.list(RECENT_BATTLES);
  const current = list.find((battle) => battle.status === 'SCHEDULED' || battle.status === 'RUNNING');
  const lines = [ctx.locale.admin.battlesTitle, ''];
  if (list.length === 0) lines.push(ctx.locale.admin.battlesEmpty);
  for (const battle of list) {
    const progress = battle.status === 'RUNNING' && battle.currentRound > 0 ? await battles.roundProgress(battle.id, battle.currentRound) : null;
    lines.push(
      ctx.locale.admin.battleInfo({
        title: escapeHtml(battle.title),
        status: battleStatusLabel(ctx.locale, battle),
        start: formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl),
        roundMinutes: battle.roundMinutes,
        finalMinutes: battle.finalMinutes ?? battle.roundMinutes,
        tiebreakMinutes: battle.tiebreakMinutes,
        entries: await battles.entriesCount(battle.id),
        round: battle.currentRound,
        progress: progress ? ctx.locale.admin.progress(progress) : null,
      }),
      '',
    );
  }
  const a = ctx.locale.admin;
  const rows = [];
  if (current) rows.push([button(a.battleCancel, `a:bt:cancel:${current.id}`)]);
  else rows.push([button(a.battleCreate, 'a:bt:new')]);
  rows.push([button(a.buttons.panel, PANEL)]);
  await respond(ctx, lines.join('\n'), { keyboard: inline(rows) });
}

function startExample(ctx: BotContext): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: ctx.deps.env.TIMEZONE, day: '2-digit', month: '2-digit' }).format(tomorrow);
  return `${date} 14:00`;
}

/** Text steps of the battle wizard; called by the admin input router. */
export async function handleBattleWizardText(ctx: BotContext, text: string): Promise<void> {
  const state = getState(ctx);
  if (state?.kind !== 'battle_create') return;
  const cancel = inline([[button(ctx.locale.common.cancel, 'a:cancel')]]);
  if (state.step === 'title') {
    const title = text.trim();
    if (!title || title.length > TITLE_MAX) {
      await ctx.reply(ctx.locale.admin.textTooLong(TITLE_MAX));
      return;
    }
    setState(ctx, { kind: 'battle_create', step: 'start', title });
    await ctx.reply(ctx.locale.admin.battleAskStart({ timeZone: ctx.deps.env.TIMEZONE, example: startExample(ctx) }), { parse_mode: 'HTML', reply_markup: cancel });
    return;
  }
  if (state.step === 'start') {
    const startsAt = parseStartTime(text, ctx.deps.env.TIMEZONE);
    if (!startsAt) {
      await ctx.reply(ctx.locale.admin.battleStartInvalid, { parse_mode: 'HTML', reply_markup: cancel });
      return;
    }
    setState(ctx, { ...state, step: 'round', startsAt: startsAt.toISOString() });
    const options = ROUND_MINUTES.map((m) => button(ctx.locale.admin.minutes(m), `a:bt:round:${m}`));
    await ctx.reply(ctx.locale.admin.battleAskRound, {
      reply_markup: inline([options.slice(0, 4), options.slice(4), [button(ctx.locale.common.cancel, 'a:cancel')]]),
    });
  }
}

export function registerBattleHandlers(admin: Composer<BotContext>): void {
  admin.action('a:bt', async (ctx) => {
    await answer(ctx);
    await showBattles(ctx);
  });

  admin.action('a:bt:new', async (ctx) => {
    setState(ctx, { kind: 'battle_create', step: 'title' });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleAskTitle, { keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]) });
  });

  admin.action(/^a:bt:round:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const minutes = matchInt(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'round' || !state.title || !state.startsAt) return answer(ctx, ctx.locale.common.alreadyProcessed);
    if (!(ROUND_MINUTES as readonly number[]).includes(minutes)) return answer(ctx);
    setState(ctx, { ...state, step: 'final', roundMinutes: minutes });
    await answer(ctx);
    const options = ROUND_MINUTES.map((m) => button(ctx.locale.admin.minutes(m), `a:bt:final:${m}`));
    await respond(ctx, ctx.locale.admin.battleAskFinal, {
      keyboard: inline([[button(ctx.locale.admin.battleFinalSame, 'a:bt:final:0')], options.slice(0, 4), options.slice(4), [button(ctx.locale.common.cancel, 'a:cancel')]]),
    });
  });

  admin.action(/^a:bt:final:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const finalMinutes = matchInt(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'final' || !state.title || !state.startsAt || !state.roundMinutes) {
      return answer(ctx, ctx.locale.common.alreadyProcessed);
    }
    if (finalMinutes !== 0 && !(ROUND_MINUTES as readonly number[]).includes(finalMinutes)) return answer(ctx);
    const minutes = state.roundMinutes;
    const startsAt = new Date(state.startsAt);
    if (startsAt <= new Date()) {
      setState(ctx, { kind: 'battle_create', step: 'start', title: state.title });
      await answer(ctx);
      await ctx.reply(ctx.locale.admin.battleStartInvalid, { parse_mode: 'HTML' });
      return;
    }
    setState(ctx, undefined);
    const battle = await ctx.deps.services.battles.schedule({
      title: state.title,
      startsAt,
      roundMinutes: minutes,
      finalMinutes: finalMinutes || null,
      tiebreakMinutes: ctx.deps.env.TIEBREAK_MINUTES,
      createdById: adminUserId(ctx),
    });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleCreated({ title: escapeHtml(battle.title), start: formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl) }), {
      keyboard: backToPanel(ctx.locale),
    });
  });

  admin.action(/^a:bt:cancel:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    await answer(ctx);
    if (!battle) return;
    await respond(ctx, ctx.locale.admin.battleCancelConfirm(escapeHtml(battle.title)), {
      keyboard: inline([[button(ctx.locale.common.yes, `a:bt:cancely:${battle.id}`), button(ctx.locale.common.no, 'a:bt')]]),
    });
  });

  admin.action(/^a:bt:cancely:(\d+)$/, async (ctx) => {
    const battleId = matchInt(ctx);
    const done = await ctx.deps.locks.withLock(`battle:${battleId}`, 30_000, async () => {
      try {
        return await ctx.deps.services.battles.cancel(battleId, adminUserId(ctx));
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (done === null) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleCancelled(escapeHtml(done.title)), { keyboard: backToPanel(ctx.locale) });
  });
}
