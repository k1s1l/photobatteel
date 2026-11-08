import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'telegraf/types';
import type { DuelSide } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { sideNumber } from './sides.js';

export const DUEL_VOTE_PREFIX = 'd:';
export const DUEL_PAID_PREFIX = 'dp:';
export const DUEL_CLOSED = 'dx';

export interface DuelKeyboardData {
  id: number;
  stage: number;
  /** Vote counts of the entries in order (2 for a pair, 3–4 in a group final). */
  votes: { side: DuelSide; votes: number }[];
}

/** Two buttons per row: "1 · 2", then "3 · 4" in a group final. */
function rowsOf(buttons: InlineKeyboardButton[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return rows;
}

/** Open voting: "Support 1 · N", "Support 2 · M", … and "⭐ +1" (buy or spend paid votes in the bot). */
export function activeDuelKeyboard(locale: Locale, duel: DuelKeyboardData, paidVotes: boolean): InlineKeyboardMarkup {
  const rows = rowsOf(
    duel.votes.map(({ side, votes }) => ({
      text: locale.duel.voteButton({ side: sideNumber(side), votes }),
      callback_data: `${DUEL_VOTE_PREFIX}${duel.id}:${duel.stage}:${side.toLowerCase()}`,
    })),
  );
  if (paidVotes) rows.push([{ text: locale.duel.paidButton, callback_data: `${DUEL_PAID_PREFIX}${duel.id}` }]);
  return { inline_keyboard: rows };
}

/** Final state: counts stay visible, the winner is marked, buttons no longer vote. */
export function closedDuelKeyboard(locale: Locale, duel: DuelKeyboardData, winner: DuelSide | 'tie'): InlineKeyboardMarkup {
  const rows = rowsOf(
    duel.votes.map(({ side, votes }) => ({
      text: `${winner === side ? '🏆 ' : ''}${locale.duel.voteButton({ side: sideNumber(side), votes })}`,
      callback_data: DUEL_CLOSED,
    })),
  );
  rows.push([{ text: winner === 'tie' ? locale.duel.tieButton : locale.duel.closedButton, callback_data: DUEL_CLOSED }]);
  return { inline_keyboard: rows };
}
