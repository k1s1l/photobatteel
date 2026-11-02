import type { Composer } from 'telegraf';
import { escapeHtml, formatDateTime } from '../../../lib/format.js';
import { isDomainError } from '../../../lib/errors.js';
import type { BotContext } from '../../context.js';
import { getState, setState } from '../../context.js';
import { answer, matchInt, respond } from '../../helpers.js';
import { button, inline } from '../../keyboards.js';
import { battleStatusLabel } from '../profile.js';
import { backToPanel, PANEL } from './keyboards.js';
import { adminUserId } from './shared.js';

const SUBMISSION_HOURS = [24, 48, 72, 120, 168] as const;
const VOTING_HOURS = [12, 24, 48, 72] as const;
const RECENT_BATTLES = 5;
const TITLE_MAX = 64;
const THEME_MAX = 200;

async function showBattles(ctx: BotContext): Promise<void> {
  const { battles } = ctx.deps.services;
  const list = await battles.list(RECENT_BATTLES);
  const current = list.find((battle) => battle.status === 'ACTIVE' || battle.status === 'VOTING');
  const tz = ctx.deps.env.TIMEZONE;
  const lines = [ctx.locale.admin.battlesTitle, ''];
  if (list.length === 0) lines.push(ctx.locale.admin.battlesEmpty);
  for (const battle of list) {
    lines.push(
      ctx.locale.battle.info({
        title: escapeHtml(battle.title),
        theme: battle.theme ? escapeHtml(battle.theme) : null,
        status: battleStatusLabel(ctx.locale, battle),
        submissionsEnd: formatDateTime(battle.submissionsEndAt, tz, ctx.locale.intl),
        end: formatDateTime(battle.endsAt, tz, ctx.locale.intl),
        participants: await battles.participantsCount(battle.id),
      }),
      '',
    );
  }

  const a = ctx.locale.admin;
  const rows = [];
  if (current?.status === 'ACTIVE') rows.push([button(a.battleCloseSubmissions, `a:bt:close:${current.id}`)]);
  if (current) rows.push([button(a.battleFinishNow, `a:bt:fin:${current.id}`), button(a.battleCancel, `a:bt:cancel:${current.id}`)]);
  if (!list.some((battle) => battle.status === 'ACTIVE')) rows.push([button(a.battleCreate, 'a:bt:new')]);
  rows.push([button(a.buttons.panel, PANEL)]);
  await respond(ctx, lines.join('\n'), { keyboard: inline(rows) });
}

function hoursKeyboard(ctx: BotContext, options: readonly number[], prefix: string) {
  return inline([options.map((h) => button(ctx.locale.admin.hours(h), `${prefix}:${h}`)), [button(ctx.locale.common.cancel, 'a:cancel')]]);
}

/** Text steps of the battle wizard; called by the admin input router. */
export async function handleBattleWizardText(ctx: BotContext, text: string): Promise<void> {
  const state = getState(ctx);
  if (state?.kind !== 'battle_create') return;
  const value = text.trim();
  if (state.step === 'title') {
    if (!value || value.length > TITLE_MAX) {
      await ctx.reply(ctx.locale.admin.textTooLong(TITLE_MAX));
      return;
    }
    setState(ctx, { kind: 'battle_create', step: 'theme', title: value });
    await ctx.reply(ctx.locale.admin.battleAskTheme, {
      reply_markup: inline([[button(ctx.locale.admin.battleNoTheme, 'a:bt:notheme')], [button(ctx.locale.common.cancel, 'a:cancel')]]),
    });
    return;
  }
  if (state.step === 'theme') {
    if (value.length > THEME_MAX) {
      await ctx.reply(ctx.locale.admin.textTooLong(THEME_MAX));
      return;
    }
    await askSubmissionDuration(ctx, state.title ?? '', value || null);
  }
}

async function askSubmissionDuration(ctx: BotContext, title: string, theme: string | null): Promise<void> {
  setState(ctx, { kind: 'battle_create', step: 'submission', title, theme });
  await respond(ctx, ctx.locale.admin.battleAskSubmission, { keyboard: hoursKeyboard(ctx, SUBMISSION_HOURS, 'a:bt:sub'), forceNew: !ctx.callbackQuery });
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

  admin.action('a:bt:notheme', async (ctx) => {
    const state = getState(ctx);
    await answer(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'theme') return;
    await askSubmissionDuration(ctx, state.title ?? '', null);
  });

  admin.action(/^a:bt:sub:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const hours = matchInt(ctx);
    await answer(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'submission' || !(SUBMISSION_HOURS as readonly number[]).includes(hours)) return;
    setState(ctx, { ...state, step: 'voting', submissionHours: hours });
    await respond(ctx, ctx.locale.admin.battleAskVoting, { keyboard: hoursKeyboard(ctx, VOTING_HOURS, 'a:bt:vote') });
  });

  admin.action(/^a:bt:vote:(\d+)$/, async (ctx) => {
    const state = getState(ctx);
    const hours = matchInt(ctx);
    if (state?.kind !== 'battle_create' || state.step !== 'voting' || !state.title || !state.submissionHours) return answer(ctx, ctx.locale.common.alreadyProcessed);
    if (!(VOTING_HOURS as readonly number[]).includes(hours)) return answer(ctx);
    setState(ctx, undefined);
    const battle = await ctx.deps.services.battles.create({
      title: state.title,
      theme: state.theme ?? null,
      submissionHours: state.submissionHours,
      votingHours: hours,
      createdById: adminUserId(ctx),
    });
    await answer(ctx);
    await respond(ctx, ctx.locale.admin.battleCreated(escapeHtml(battle.title)), { keyboard: backToPanel(ctx.locale) });
  });

  const lifecycle = async (ctx: BotContext, action: 'close' | 'fin' | 'cancel') => {
    const battleId = matchInt(ctx);
    const { battles } = ctx.deps.services;
    const done = await ctx.deps.locks.withLock(`battle:${battleId}`, 30_000, async () => {
      try {
        if (action === 'close') return ctx.locale.admin.battleVotingStarted(escapeHtml((await battles.closeSubmissions(battleId, adminUserId(ctx))).title));
        if (action === 'fin') return ctx.locale.admin.battleFinished(escapeHtml((await battles.finish(battleId, adminUserId(ctx))).battle.title));
        return ctx.locale.admin.battleCancelled(escapeHtml((await battles.cancel(battleId, adminUserId(ctx))).title));
      } catch (error) {
        if (isDomainError(error) && error.code === 'INVALID_STATE') return null;
        throw error;
      }
    });
    if (done === undefined) return answer(ctx, ctx.locale.common.busy);
    if (done === null) return answer(ctx, ctx.locale.common.alreadyProcessed, true);
    await answer(ctx);
    await respond(ctx, done, { keyboard: inline([[button(ctx.locale.admin.buttons.battles, 'a:bt'), button(ctx.locale.admin.buttons.panel, PANEL)]]) });
  };
  admin.action(/^a:bt:close:(\d+)$/, (ctx) => lifecycle(ctx, 'close'));
  admin.action(/^a:bt:fin:(\d+)$/, (ctx) => lifecycle(ctx, 'fin'));
  admin.action(/^a:bt:cancel:(\d+)$/, (ctx) => lifecycle(ctx, 'cancel'));
}
