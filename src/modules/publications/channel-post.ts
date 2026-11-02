import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { Locale } from '../../i18n/index.js';
import { displayName, escapeHtml, formatPhotoId, type NamedUser } from '../../lib/format.js';

export const VOTE_CALLBACK_PREFIX = 'v:';
export const BOOST_CALLBACK_PREFIX = 'b:';

export function buildChannelCaption(locale: Locale, photo: { id: number }, author: NamedUser, battleTitle: string | null): string {
  return locale.channel.caption({
    participant: escapeHtml(displayName(author)),
    id: formatPhotoId(photo.id),
    battle: battleTitle ? escapeHtml(battleTitle) : null,
  });
}

/** "🔥 Support · N" and, when paid votes are on, "⭐ +1 vote" (spends a purchased vote). */
export function buildVoteKeyboard(locale: Locale, photoId: number, votes: number, paidVotes = false): InlineKeyboardMarkup {
  const row = [{ text: locale.vote.button(votes), callback_data: `${VOTE_CALLBACK_PREFIX}${photoId}` }];
  if (paidVotes) row.push({ text: locale.vote.boostButton, callback_data: `${BOOST_CALLBACK_PREFIX}${photoId}` });
  return { inline_keyboard: [row] };
}
