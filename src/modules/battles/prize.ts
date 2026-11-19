import type { BotSettings } from '../../generated/prisma/client.js';

export interface PrizeRules {
  base: number;
  threshold: number;
  /** Stars added per 100 paid votes over the threshold (50 = +0.5 per vote). */
  perHundred: number;
}

export interface PrizeState {
  /** Prize in whole stars (halves are rounded down). */
  stars: number;
  /** Paid votes still needed before the prize starts growing (0 once it grows). */
  left: number;
  paidVotes: number;
}

export function prizeRules(settings: Pick<BotSettings, 'prizeEnabled' | 'prizeBase' | 'prizeThreshold' | 'prizePerHundred'>): PrizeRules | null {
  return settings.prizeEnabled ? { base: settings.prizeBase, threshold: settings.prizeThreshold, perHundred: settings.prizePerHundred } : null;
}

/** 300⭐; after 600 paid votes every vote adds 0.5⭐: 700 votes → 350⭐. No upper limit. */
export function prizeFor(paidVotes: number, rules: PrizeRules): PrizeState {
  const over = Math.max(0, paidVotes - rules.threshold);
  return { stars: rules.base + Math.floor((over * rules.perHundred) / 100), left: Math.max(0, rules.threshold - paidVotes), paidVotes };
}

/** "0,5" for 50 per hundred. */
export function formatPerVote(perHundred: number): string {
  return String(perHundred / 100).replace('.', ',');
}
