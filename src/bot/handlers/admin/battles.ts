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
const FINAL_SIZES = [2, 3, 4] as const;
const RECENT_BATTLES = 5;

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
  if (current?.status === 'RUNNING' && current.currentRound > 0) {
    rows.push([button(a.roundEndButton, `a:bt:end:${current.id}`)]);
    const duels = await battles.republishable(current.id, current.currentRound);
    for (let i = 0; i < duels.length; i += 2) rows.push(duels.slice(i, i + 2).map((duel) => button(a.republishButton(duel.position), `a:bt:rp:${duel.id}`)));
  }
  if (current) rows.push([button(a.finalSizeButton(current.finalSize), `a:bt:fs:${current.id}`)]);
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

/** The admin typed when the current round should end. */
export async function handleRoundEndText(ctx: BotContext, battleId: number, text: string): Promise<void> {
  const at = parseStartTime(text, ctx.deps.env.TIMEZONE);
  if (!at) {
    await ctx.reply(ctx.locale.admin.battleStartInvalid, { parse_mode: 'HTML', reply_markup: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]) });
    return;
  }
  setState(ctx, undefined);
  try {
    const { battle, changed } = await ctx.deps.services.battles.setRoundEnd(battleId, at, adminUserId(ctx));
    await ctx.reply(ctx.locale.admin.roundEndSet({ round: battle.currentRound, end: formatDateTime(at, ctx.deps.env.TIMEZONE, ctx.locale.intl), changed }), {
      parse_mode: 'HTML',
      reply_markup: inline([[button(ctx.locale.common.back, 'a:bt')]]),
    });
  } catch (error) {
    if (!isDomainError(error)) throw error;
    await ctx.reply(ctx.locale.common.alreadyProcessed, { reply_markup: inline([[button(ctx.locale.common.back, 'a:bt')]]) });
  }
}

/** Text steps of the battle wizard; called by the admin input router. */
export async function handleBattleWizardText(ctx: BotContext, text: string): Promise<void> {
  const state = getState(ctx);
  if (state?.kind !== 'battle_create') return;
  const cancel = inline([[button(ctx.locale.common.cancel, 'a:cancel')]]);
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

  // The battle is named automatically ("Фотобатл #N"); the wizard starts with the start time.
  admin.action('a:bt:new', async (ctx) => {
    setState(ctx, { kind: 'battle_create', step: 'start' });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleAskStart({ timeZone: ctx.deps.env.TIMEZONE, example: startExample(ctx) }), {
      keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]),
    });
  });

  admin.action(/^a:bt:round:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const minutes = matchInt(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'round' || !state.startsAt) return answer(ctx, ctx.locale.common.alreadyProcessed);
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
    if (state?.kind !== 'battle_create' || state.step !== 'final' || !state.startsAt || !state.roundMinutes) {
      return answer(ctx, ctx.locale.common.alreadyProcessed);
    }
    if (finalMinutes !== 0 && !(ROUND_MINUTES as readonly number[]).includes(finalMinutes)) return answer(ctx);
    setState(ctx, { ...state, step: 'size', finalMinutes });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleAskFinalSize, {
      keyboard: inline([
        FINAL_SIZES.map((size) => button(ctx.locale.admin.finalSizeOption(size), `a:bt:size:${size}`)),
        [button(ctx.locale.common.cancel, 'a:cancel')],
      ]),
    });
  });

  admin.action(/^a:bt:size:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const finalSize = matchInt(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'size' || !state.startsAt || !state.roundMinutes || state.finalMinutes === undefined) {
      return answer(ctx, ctx.locale.common.alreadyProcessed);
    }
    if (!(FINAL_SIZES as readonly number[]).includes(finalSize)) return answer(ctx);
    const finalMinutes = state.finalMinutes;
    const minutes = state.roundMinutes;
    const startsAt = new Date(state.startsAt);
    if (startsAt <= new Date()) {
      setState(ctx, { kind: 'battle_create', step: 'start' });
      await answer(ctx);
      await ctx.reply(ctx.locale.admin.battleStartInvalid, { parse_mode: 'HTML' });
      return;
    }
    setState(ctx, undefined);
    const battle = await ctx.deps.services.battles.schedule({
      startsAt,
      roundMinutes: minutes,
      finalMinutes: finalMinutes || null,
      finalSize,
      tiebreakMinutes: ctx.deps.env.TIEBREAK_MINUTES,
      createdById: adminUserId(ctx),
    });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleCreated({ title: escapeHtml(battle.title), start: formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl) }), {
      keyboard: backToPanel(ctx.locale),
    });
  });

  // 2 → 3 → 4 → 2 entries in the final; locked once the final has started.
  admin.action(/^a:bt:fs:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    if (!battle) return answer(ctx);
    const next = battle.finalSize >= 4 ? 2 : battle.finalSize + 1;
    try {
      await ctx.deps.services.battles.setFinalSize(battle.id, next, adminUserId(ctx));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      return answer(ctx, ctx.locale.admin.finalSizeLocked, true);
    }
    await answer(ctx, ctx.locale.admin.finalSizeSet(next));
    await showBattles(ctx);
  });

  admin.action(/^a:bt:end:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    await answer(ctx);
    if (battle?.status !== 'RUNNING') return;
    setState(ctx, { kind: 'battle_round_end', battleId: battle.id });
    const current = battle.roundEndsAt ? formatDateTime(battle.roundEndsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl) : null;
    await respond(ctx, ctx.locale.admin.roundEndAsk({ round: battle.currentRound, current, example: startExample(ctx) }), {
      keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]),
      forceNew: true,
    });
  });

  admin.action(/^a:bt:rp:(\d+)$/, async (ctx) => {
    const duel = await ctx.deps.services.battles.getDuel(matchInt(ctx));
    await answer(ctx);
    if (!duel) return;
    await respond(ctx, ctx.locale.admin.republishConfirm(duel.position), {
      keyboard: inline([[button(ctx.locale.common.yes, `a:bt:rpy:${duel.id}`), button(ctx.locale.common.no, 'a:bt')]]),
    });
  });

  admin.action(/^a:bt:rpy:(\d+)$/, async (ctx) => {
    const duelId = matchInt(ctx);
    const done = await ctx.deps.locks.withLock(`duel:${duelId}`, 30_000, () => ctx.deps.services.battles.republish(duelId, adminUserId(ctx)));
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (!done) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.republishDone, { keyboard: inline([[button(ctx.locale.common.back, 'a:bt')]]) });
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
