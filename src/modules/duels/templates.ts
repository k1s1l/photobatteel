import type { BotSettings } from '../../generated/prisma/client.js';
import type { Locale } from '../../i18n/index.js';
import { linkifyHtml } from '../../lib/entities-html.js';
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
  duel: ['battle', 'stage', 'roundName', 'round', 'duel', 'end'],
  announce: ['battle', 'start', 'bot'],
  round: ['battle', 'roundName', 'round', 'entries', 'end'],
  winner: ['battle', 'votes'],
  buttons: ['stage', 'roundName', 'round', 'duel', 'end'],
};

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Templates that can have a separate design for every round, the semifinal and the final. */
export const STAGED_KEYS = ['duel', 'round', 'buttons'] as const;
export type StagedKey = (typeof STAGED_KEYS)[number];

export const STAGE_VARIANTS = ['r1', 'r2', 'r3', 'r4', 'final'] as const;
export type StageVariant = (typeof STAGE_VARIANTS)[number];

export function isStagedKey(value: string): value is StagedKey {
  return (STAGED_KEYS as readonly string[]).includes(value);
}

export function isStageVariant(value: string): value is StageVariant {
  return (STAGE_VARIANTS as readonly string[]).includes(value);
}

/** Where a post belongs in the tournament. */
export interface StagePoint {
  round: number;
  entriesInRound: number;
}

/** The final wins over the round number (a small battle may start with its final). */
export function stageVariant(point: StagePoint): StageVariant | null {
  if (point.entriesInRound <= 2) return 'final';
  const id = `r${point.round}`;
  return isStageVariant(id) ? id : null;
}

export function stageTemplateId(key: StagedKey, variant: StageVariant): string {
  return `${key}:${variant}`;
}

/** Per-round designs saved by admins. */
export function stageTemplates(settings: BotSettings): Record<string, string> {
  const raw = settings.stageTemplates;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The admin's design for this round, else their general design, else the default text of the channel language. */
export function templateFor(settings: BotSettings, locale: Locale, key: TemplateKey, point?: StagePoint): string {
  if (point && isStagedKey(key)) {
    const variant = stageVariant(point);
    const staged = variant ? stageTemplates(settings)[stageTemplateId(key, variant)] : undefined;
    if (staged) return staged;
  }
  return settings[TEMPLATE_FIELDS[key]] ?? locale.templates[key];
}

/** Replaces known {placeholders}; values are HTML-escaped, the template's own markup is kept. */
export function renderTemplate(template: string, key: TemplateKey, values: Record<string, string | number>): string {
  const allowed = TEMPLATE_PLACEHOLDERS[key];
  const html = template.replace(/\{(\w+)\}/g, (match, name: string) =>
    allowed.includes(name) && values[name] !== undefined ? escapeHtml(String(values[name])) : match,
  );
  // Templates saved before links were kept explicitly may hold plain URLs.
  return linkifyHtml(html);
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
