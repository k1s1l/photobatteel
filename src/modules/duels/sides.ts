import type { DuelSide } from '../../generated/prisma/client.js';

/**
 * A duel holds 2 entries (a regular pair) or, in a group final, 3–6 entries.
 * Slot A is shown as "1", B as "2", … F as "6".
 */
export const SIDES = ['A', 'B', 'C', 'D', 'E', 'F'] as const satisfies readonly DuelSide[];
export type SideNumber = 1 | 2 | 3 | 4 | 5 | 6;

export const MAX_FINAL_SIZE = 6;

export const VOTE_FIELD = { A: 'votesA', B: 'votesB', C: 'votesC', D: 'votesD', E: 'votesE', F: 'votesF' } as const satisfies Record<DuelSide, string>;
export const PHOTO_ID_FIELD = { A: 'photoAId', B: 'photoBId', C: 'photoCId', D: 'photoDId', E: 'photoEId', F: 'photoFId' } as const satisfies Record<DuelSide, string>;

export interface DuelSlots {
  photoAId: number;
  photoBId: number | null;
  photoCId: number | null;
  photoDId: number | null;
  photoEId: number | null;
  photoFId: number | null;
}

export interface DuelVotes {
  votesA: number;
  votesB: number;
  votesC: number;
  votesD: number;
  votesE: number;
  votesF: number;
}

export function sideNumber(side: DuelSide): SideNumber {
  return (SIDES.indexOf(side) + 1) as SideNumber;
}

/** "a".."f" from a callback → side, or null. */
export function sideFromLetter(letter: string): DuelSide | null {
  const side = letter.toUpperCase();
  return (SIDES as readonly string[]).includes(side) ? (side as DuelSide) : null;
}

/** Filled slots in order: [{ side: 'A', photoId }, …]. */
export function entriesOf(duel: DuelSlots): { side: DuelSide; photoId: number }[] {
  return SIDES.flatMap((side) => {
    const photoId = duel[PHOTO_ID_FIELD[side]];
    return photoId === null ? [] : [{ side, photoId }];
  });
}

export function entryCount(duel: DuelSlots): number {
  return entriesOf(duel).length;
}

export function sideOf(duel: DuelSlots, photoId: number): DuelSide | null {
  return entriesOf(duel).find((entry) => entry.photoId === photoId)?.side ?? null;
}

export function votesOf(duel: DuelVotes, side: DuelSide): number {
  return duel[VOTE_FIELD[side]];
}

/** Prisma filter: the photo plays in any slot of the duel. */
export function inAnySlot(photoId: number) {
  return { OR: [{ photoAId: photoId }, { photoBId: photoId }, { photoCId: photoId }, { photoDId: photoId }, { photoEId: photoId }, { photoFId: photoId }] };
}

/** Prisma filter: a file of any entry of the duel matches. */
export function anySlotFile(fileUniqueIds: string[]) {
  const file = { fileUniqueId: { in: fileUniqueIds } };
  return [{ photoA: file }, { photoB: file }, { photoC: file }, { photoD: file }, { photoE: file }, { photoF: file }];
}

export const ALL_PHOTOS = { photoA: true, photoB: true, photoC: true, photoD: true, photoE: true, photoF: true } as const;

/** Vote counts of all filled slots, in order. */
export function voteList(duel: DuelSlots & DuelVotes): { side: DuelSide; votes: number }[] {
  return entriesOf(duel).map(({ side }) => ({ side, votes: votesOf(duel, side) }));
}

export const ZERO_VOTES: DuelVotes = { votesA: 0, votesB: 0, votesC: 0, votesD: 0, votesE: 0, votesF: 0 };

/** Every vote counter of a duel (for Prisma selects). */
export const VOTE_SELECT = { votesA: true, votesB: true, votesC: true, votesD: true, votesE: true, votesF: true } as const;
