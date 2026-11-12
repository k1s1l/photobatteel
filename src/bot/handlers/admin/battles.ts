import { MAX_FINAL_SIZE } from '../../../modules/duels/sides.js';
import type { Composer } from 'telegraf';
import { escapeHtml, formatDateTime } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import { parseStartTime } from '../../../lib/time.js';
import type { BotContext } from '../../context.js';
import { getState, setState } from '../../context.js';
import { answer, matchInt, matchString, respond } from '../../helpers.js';
import { sideFromLetter, sideNumber, voteList } from '../../../modules/duels/sides.js';
import { button, inline } from '../../keyboards.js';
import { battleStatusLabel } from '../profile.js';
import { backToPanel, PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const ROUND_MINUTES = [15, 30, 60, 120, 180, 360, 720, 1440] as const;
const FINAL_SIZES = [2, 3, 4, 5, 6] as const;
/** "+30 min / +1 h / +2 h" for collecting photos longer. */
const EXTEND_MINUTES = [30, 60, 120] as const;
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
    rows.push([button(a.finishNowButton, `a:bt:fin:${current.id}`)]);
    rows.push([button(a.votesButton, `a:bt:votes:${current.id}`)]);
    const duels = await battles.republishable(current.id, current.currentRound);
    for (let i = 0; i < duels.length; i += 2) rows.push(duels.slice(i, i + 2).map((duel) => button(a.republishButton(duel.position), `a:bt:rp:${duel.id}`)));
  }
  if (current?.status === 'SCHEDULED') {
    rows.push(EXTEND_MINUTES.map((m) => button(a.extendButton(m), `a:bt:ext:${current.id}:${m}`)));
    rows.push([button(a.startTimeButton, `a:bt:st:${current.id}`)]);
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

async function moveStart(ctx: BotContext, battleId: number, startsAt: Date): Promise<void> {
  try {
    const battle = await ctx.deps.services.battles.reschedule(battleId, startsAt, adminUserId(ctx));
    await ctx.reply(ctx.locale.admin.startMoved(formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl)), {
      parse_mode: 'HTML',
      reply_markup: inline([[button(ctx.locale.common.back, 'a:bt')]]),
    });
  } catch (error) {
    if (!isDomainError(error) && !(error instanceof RangeError)) throw error;
    await ctx.reply(ctx.locale.common.alreadyProcessed, { reply_markup: inline([[button(ctx.locale.common.back, 'a:bt')]]) });
  }
}

/** The admin typed a new start time for a scheduled battle. */
export async function handleStartTimeText(ctx: BotContext, battleId: number, text: string): Promise<void> {
  const at = parseStartTime(text, ctx.deps.env.TIMEZONE);
  if (!at) {
    await ctx.reply(ctx.locale.admin.battleStartInvalid, { parse_mode: 'HTML', reply_markup: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]) });
    return;
  }
  setState(ctx, undefined);
  await moveStart(ctx, battleId, at);
}

const VOTE_STEPS = [-5, -1, 1, 5, 10] as const;

/** One pair: votes of every entry and buttons to add or remove votes. */
async function showDuelVotes(ctx: BotContext, duelId: number): Promise<void> {
  const duel = await ctx.deps.services.battles.getDuel(duelId);
  const a = ctx.locale.admin;
  if (!duel || duel.status === 'FINISHED') {
    await respond(ctx, ctx.locale.common.alreadyProcessed, { keyboard: inline([[button(ctx.locale.common.back, 'a:bt')]]) });
    return;
  }
  const entries = voteList(duel);
  const rows = entries.flatMap(({ side }) => [
    VOTE_STEPS.map((step) => button(`${sideNumber(side)}: ${step > 0 ? '+' : ''}${step}`, `a:bt:va:${duel.id}:${side.toLowerCase()}:${step}`)),
    [button(a.votesCustom(sideNumber(side)), `a:bt:vi:${duel.id}:${side.toLowerCase()}`)],
  ]);
  await respond(ctx, a.votesScreen({ duel: duel.position, lines: entries.map(({ side, votes }) => a.votesLine(sideNumber(side), votes)).join('\n') }), {
    keyboard: inline([...rows, [button(ctx.locale.common.back, `a:bt:votes:${duel.battleId}`)]]),
  });
}

async function applyVotes(ctx: BotContext, duelId: number, letter: string, delta: number): Promise<boolean> {
  const side = sideFromLetter(letter);
  if (!side) return false;
  try {
    await ctx.deps.services.battles.adjustVotes(duelId, side, delta, adminUserId(ctx));
    return true;
  } catch (error) {
    if ((isDomainError(error) && error.code === 'INVALID_STATE') || error instanceof RangeError) return false;
    throw error;
  }
}

/** Text answer to "how many votes": e.g. 20 or -3. */
export async function handleVotesInput(ctx: BotContext, duelId: number, letter: string, text: string): Promise<void> {
  const delta = Number(text.trim().replace('+', ''));
  if (!Number.isInteger(delta) || delta === 0) {
    await ctx.reply(ctx.locale.admin.votesInvalid, { reply_markup: inline([[button(ctx.locale.common.cancel, `a:bt:v:${duelId}`)]]) });
    return;
  }
  setState(ctx, undefined);
  const ok = await applyVotes(ctx, duelId, letter, delta);
  if (!ok) await ctx.reply(ctx.locale.common.alreadyProcessed);
  await showDuelVotes(ctx, duelId);
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
        FINAL_SIZES.slice(0, 3).map((size) => button(ctx.locale.admin.finalSizeOption(size), `a:bt:size:${size}`)),
        FINAL_SIZES.slice(3).map((size) => button(ctx.locale.admin.finalSizeOption(size), `a:bt:size:${size}`)),
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

  // 2 → 3 → … → 6 → 2 entries in the final; locked once the final has started.
  admin.action(/^a:bt:fs:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    if (!battle) return answer(ctx);
    const next = battle.finalSize >= MAX_FINAL_SIZE ? 2 : battle.finalSize + 1;
    try {
      await ctx.deps.services.battles.setFinalSize(battle.id, next, adminUserId(ctx));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      return answer(ctx, error.code === 'VOTING_STARTED' ? ctx.locale.admin.finalSizeVoting : ctx.locale.admin.finalSizeLocked, true);
    }
    await answer(ctx, ctx.locale.admin.finalSizeSet(next));
    await showBattles(ctx);
  });

  // More time to collect photos: the start moves later by 30 min / 1 h / 2 h.
  admin.action(/^a:bt:ext:(\d+):(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx, 1));
    const minutes = matchInt(ctx, 2);
    await answer(ctx);
    if (battle?.status !== 'SCHEDULED' || !(EXTEND_MINUTES as readonly number[]).includes(minutes)) return;
    await moveStart(ctx, battle.id, new Date(battle.startsAt.getTime() + minutes * 60_000));
  });

  admin.action(/^a:bt:st:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    await answer(ctx);
    if (battle?.status !== 'SCHEDULED') return;
    setState(ctx, { kind: 'battle_start_change', battleId: battle.id });
    await respond(ctx, ctx.locale.admin.startTimeAsk({ current: formatDateTime(battle.startsAt, ctx.deps.env.TIMEZONE, ctx.locale.intl), example: startExample(ctx) }), {
      keyboard: inline([[button(ctx.locale.common.cancel, 'a:cancel')]]),
      forceNew: true,
    });
  });

  admin.action(/^a:bt:votes:(\d+)$/, async (ctx) => {
    await answer(ctx);
    const duels = await ctx.deps.services.battles.openDuels(matchInt(ctx));
    const a = ctx.locale.admin;
    const rows = [];
    for (let i = 0; i < duels.length; i += 2) rows.push(duels.slice(i, i + 2).map((duel) => button(a.votesPair(duel.position), `a:bt:v:${duel.id}`)));
    await respond(ctx, duels.length > 0 ? a.votesChoosePair : a.votesNoPairs, { keyboard: inline([...rows, [button(ctx.locale.common.back, 'a:bt')]]) });
  });

  admin.action(/^a:bt:v:(\d+)$/, async (ctx) => {
    setState(ctx, undefined);
    await answer(ctx);
    await showDuelVotes(ctx, matchInt(ctx));
  });

  admin.action(/^a:bt:va:(\d+):([a-f]):(-?\d+)$/, async (ctx) => {
    const duelId = matchInt(ctx, 1);
    const delta = Number(matchString(ctx, 3));
    const ok = (VOTE_STEPS as readonly number[]).includes(delta) && (await applyVotes(ctx, duelId, matchString(ctx, 2), delta));
    await answer(ctx, ok ? ctx.locale.admin.votesSaved : ctx.locale.common.alreadyProcessed, !ok);
    await showDuelVotes(ctx, duelId);
  });

  admin.action(/^a:bt:vi:(\d+):([a-f])$/, async (ctx) => {
    await answer(ctx);
    const duelId = matchInt(ctx, 1);
    const letter = matchString(ctx, 2);
    setState(ctx, { kind: 'admin_votes', duelId, side: letter });
    await respond(ctx, ctx.locale.admin.votesAsk(sideNumber(sideFromLetter(letter)!)), {
      keyboard: inline([[button(ctx.locale.common.cancel, `a:bt:v:${duelId}`)]]),
      forceNew: true,
    });
  });

  admin.action(/^a:bt:fin:(\d+)$/, async (ctx) => {
    const battle = await ctx.deps.services.battles.findById(matchInt(ctx));
    await answer(ctx);
    if (battle?.status !== 'RUNNING') return;
    await respond(ctx, ctx.locale.admin.finishNowConfirm(battle.currentRound), {
      keyboard: inline([[button(ctx.locale.common.yes, `a:bt:finy:${battle.id}`), button(ctx.locale.common.no, 'a:bt')]]),
    });
  });

  admin.action(/^a:bt:finy:(\d+)$/, async (ctx) => {
    const battleId = matchInt(ctx);
    const done = await ctx.deps.locks.withLock(`battle:${battleId}`, 60_000, async () => {
      try {
        return await ctx.deps.services.battles.finishRoundNow(battleId, adminUserId(ctx));
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (done === null) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    await respond(ctx, done.battle.status === 'FINISHED' ? ctx.locale.admin.finishNowDoneBattle : ctx.locale.admin.finishNowDoneRound, {
      keyboard: inline([[button(ctx.locale.common.back, 'a:bt')]]),
    });
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
    await respond(ctx, ctx.locale.admin.republishDone((await ctx.deps.services.settings.get()).autoPublish), { keyboard: inline([[button(ctx.locale.common.back, 'a:bt')]]) });
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
