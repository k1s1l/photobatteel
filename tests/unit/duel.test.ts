import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { pairEntries, shuffle } from '../../src/modules/battles/battle.service.js';
import { buildDuelCollage } from '../../src/modules/duels/collage.js';
import { activeDuelKeyboard, closedDuelKeyboard } from '../../src/modules/duels/duel-post.js';
import { renderTemplate, roundName, stageVariant, stageValues } from '../../src/modules/duels/templates.js';
import { uk } from '../../src/i18n/locales/uk.js';
import { makeJpeg, makePng } from '../helpers/images.js';

describe('pairing', () => {
  it('pairs entries in order and gives the last one a bye when the count is odd', () => {
    expect(pairEntries([1, 2, 3, 4])).toEqual([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(pairEntries([1, 2, 3])).toEqual([{ a: 1, b: 2 }, { a: 3, b: null }]);
    expect(pairEntries([7])).toEqual([{ a: 7, b: null }]);
  });

  it('shuffles without losing or duplicating entries', () => {
    const ids = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = shuffle(ids);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(ids);
    expect(shuffled).not.toEqual(ids); // 1/50! chance of a false failure
  });
});

describe('duel post', () => {
  it('fills templates, escapes values and leaves unknown placeholders alone', () => {
    const template = '<b>{battle}</b> · {stage} · {unknown} · {start}';
    expect(renderTemplate(template, 'duel', { battle: 'A&B', stage: 'Раунд 2 · Пара 5', start: 'x' })).toBe('<b>A&amp;B</b> · Раунд 2 · Пара 5 · {unknown} · {start}');
    expect(renderTemplate('{bot} {start}', 'announce', { bot: '@pb_bot', start: '14:00' })).toBe('@pb_bot 14:00');
  });

  it('names the last rounds "Фінал" and "Півфінал"', () => {
    expect(roundName(uk, 1, 16)).toBe('Раунд 1');
    expect(roundName(uk, 3, 4)).toBe('Півфінал');
    expect(roundName(uk, 2, 3)).toBe('Півфінал');
    expect(roundName(uk, 4, 2)).toBe('Фінал');
    expect(stageValues(uk, { round: 4, entriesInRound: 2, duel: 1, stage: 0 }).stage).toBe('Фінал');
    expect(stageValues(uk, { round: 3, entriesInRound: 4, duel: 2, stage: 0 }).stage).toBe('Півфінал · Пара 2');
    expect(stageValues(uk, { round: 1, entriesInRound: 9, duel: 5, stage: 1 }).stage).toBe('⚡ Переголосування! Раунд 1 · Пара 5');
  });

  it('builds vote buttons for both entries and the paid +1 button', () => {
    const markup = activeDuelKeyboard(uk, { id: 7, stage: 1, votesA: 12, votesB: 9 }, true);
    expect(markup.inline_keyboard[0]?.map((b) => [b.text, 'callback_data' in b ? b.callback_data : ''])).toEqual([
      ['Підтримати 1 · 12', 'd:7:1:a'],
      ['Підтримати 2 · 9', 'd:7:1:b'],
    ]);
    expect(markup.inline_keyboard[1]?.[0]).toMatchObject({ text: '⭐ +1 голос', callback_data: 'dp:7' });
    expect(activeDuelKeyboard(uk, { id: 7, stage: 0, votesA: 0, votesB: 0 }, false).inline_keyboard).toHaveLength(1);
  });

  it('marks the winner on the closed keyboard', () => {
    const markup = closedDuelKeyboard(uk, { id: 7, stage: 0, votesA: 3, votesB: 5 }, 'b');
    expect(markup.inline_keyboard[0]?.[1]?.text).toBe('🏆 Підтримати 2 · 5');
    expect(closedDuelKeyboard(uk, { id: 7, stage: 0, votesA: 4, votesB: 4 }, 'tie').inline_keyboard[1]?.[0]?.text).toContain('Нічия');
  });

  it('builds one collage image from two photos of any size', async () => {
    const collage = await buildDuelCollage(await makeJpeg(1200, 800), await makePng(500, 900));
    const meta = await sharp(collage).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1452, height: 900 });
  });
});

describe('per-round designs', () => {
  it('picks the final and the semifinal before the round number', () => {
    expect(stageVariant({ round: 1, entriesInRound: 16 })).toBe('r1');
    expect(stageVariant({ round: 3, entriesInRound: 8 })).toBe('r3');
    expect(stageVariant({ round: 1, entriesInRound: 4 })).toBe('semi');
    expect(stageVariant({ round: 1, entriesInRound: 2 })).toBe('final');
    expect(stageVariant({ round: 6, entriesInRound: 64 })).toBeNull();
  });
});
