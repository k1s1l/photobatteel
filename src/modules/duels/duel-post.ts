import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { Locale } from '../../i18n/index.js';
import { escapeHtml } from '../../lib/format.js';

export const DUEL_VOTE_PREFIX = 'd:';
export const DUEL_PAID_PREFIX = 'dp:';
export const DUEL_CLOSED = 'dx';

export interface DuelCaptionData {
  battleTitle: string;
  round: number;
  position: number;
  stage: number;
}

/**
 * Fills the duel template. Placeholders: {battle}, {round}, {duel}, {stage}.
 * The template is HTML (admin-designed, may contain premium emoji); values are escaped.
 */
export function renderDuelCaption(template: string, locale: Locale, data: DuelCaptionData): string {
  const stageLabel = data.stage === 0 ? locale.duel.stageMain({ round: data.round, duel: data.position }) : locale.duel.stageTiebreak({ round: data.round, duel: data.position });
  const values: Record<string, string> = {
    battle: escapeHtml(data.battleTitle),
    round: String(data.round),
    duel: String(data.position),
    stage: escapeHtml(stageLabel),
  };
  return template.replace(/\{(battle|round|duel|stage)\}/g, (_, key: string) => values[key] ?? '');
}

export interface DuelKeyboardData {
  id: number;
  stage: number;
  votesA: number;
  votesB: number;
}

/** Open voting: "Support 1 · N", "Support 2 · M" and "⭐ +1" (buy or spend paid votes in the bot). */
export function activeDuelKeyboard(locale: Locale, duel: DuelKeyboardData, paidVotes: boolean): InlineKeyboardMarkup {
  const rows = [
    [
      { text: locale.duel.voteButton({ side: 1, votes: duel.votesA }), callback_data: `${DUEL_VOTE_PREFIX}${duel.id}:${duel.stage}:a` },
      { text: locale.duel.voteButton({ side: 2, votes: duel.votesB }), callback_data: `${DUEL_VOTE_PREFIX}${duel.id}:${duel.stage}:b` },
    ],
  ];
  if (paidVotes) rows.push([{ text: locale.duel.paidButton, callback_data: `${DUEL_PAID_PREFIX}${duel.id}` }]);
  return { inline_keyboard: rows };
}

/** Final state: counts stay visible, the winner is marked, buttons no longer vote. */
export function closedDuelKeyboard(locale: Locale, duel: DuelKeyboardData, winner: 'a' | 'b' | 'tie'): InlineKeyboardMarkup {
  const mark = (side: 'a' | 'b') => (winner === side ? '🏆 ' : '');
  return {
    inline_keyboard: [
      [
        { text: `${mark('a')}${locale.duel.voteButton({ side: 1, votes: duel.votesA })}`, callback_data: DUEL_CLOSED },
        { text: `${mark('b')}${locale.duel.voteButton({ side: 2, votes: duel.votesB })}`, callback_data: DUEL_CLOSED },
      ],
      [{ text: winner === 'tie' ? locale.duel.tieButton : locale.duel.closedButton, callback_data: DUEL_CLOSED }],
    ],
  };
}
