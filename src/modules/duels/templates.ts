import type { BotSettings } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { escapeHtml } from '../../lib/format.js';

/** Every post the bot prepares can be designed by an admin. */
export const TEMPLATE_KEYS = ['duel', 'announce', 'round', 'winner', 'buttons'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const TEMPLATE_FIELDS = {
  duel: 'duelTemplate',
  announce: 'announceTemplate',
  round: 'roundTemplate',
  winner: 'winnerTemplate',
  buttons: 'buttonsTemplate',
} as const satisfies Record<TemplateKey, keyof BotSettings>;

/** Placeholders each template understands. */
export const TEMPLATE_PLACEHOLDERS: Record<TemplateKey, readonly string[]> = {
  duel: ['battle', 'stage', 'roundName', 'round', 'duel'],
  announce: ['battle', 'start', 'bot'],
  round: ['battle', 'roundName', 'round', 'entries'],
  winner: ['battle', 'votes'],
  buttons: ['stage', 'roundName', 'round', 'duel'],
};

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** The admin's design, or the default text of the channel language. */
export function templateFor(settings: BotSettings, locale: Locale, key: TemplateKey): string {
  return settings[TEMPLATE_FIELDS[key]] ?? locale.templates[key];
}

/** Replaces known {placeholders}; values are HTML-escaped, the template's own markup is kept. */
export function renderTemplate(template: string, key: TemplateKey, values: Record<string, string | number>): string {
  const allowed = TEMPLATE_PLACEHOLDERS[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    allowed.includes(name) && values[name] !== undefined ? escapeHtml(String(values[name])) : match,
  );
}

/** "Фінал" for the last pair, "Півфінал" for 3–4 entries, otherwise "Раунд N". */
export function roundName(locale: Locale, round: number, entriesInRound: number): string {
  if (entriesInRound <= 2) return locale.duel.roundNames.final;
  if (entriesInRound <= 4) return locale.duel.roundNames.semifinal;
  return locale.duel.roundNames.round(round);
}

export interface StageInfo {
  round: number;
  entriesInRound: number;
  duel: number;
  stage: number;
}

/** Values shared by the duel post and the buttons message. */
export function stageValues(locale: Locale, info: StageInfo): Record<string, string | number> {
  const name = roundName(locale, info.round, info.entriesInRound);
  const final = info.entriesInRound <= 2;
  return {
    roundName: name,
    round: info.round,
    duel: info.duel,
    stage: locale.duel.stage({ roundName: name, duel: info.duel, final, tiebreak: info.stage > 0 }),
  };
}
