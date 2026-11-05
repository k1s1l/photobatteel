import { describe, expect, it } from 'vitest';
import { entitiesToHtml, stripCustomEmoji, visibleLength } from '../../src/lib/entities-html.js';

describe('message entities → HTML template', () => {
  it('keeps formatting and premium emoji', () => {
    const text = '🔥 PHOTO BATTLE {stage}';
    const html = entitiesToHtml(text, [
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5368324170671202286' },
      { type: 'bold', offset: 3, length: 12 },
    ]);
    expect(html).toBe('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> <b>PHOTO BATTLE</b> {stage}');
  });

  it('escapes HTML in the text and nests overlapping entities correctly', () => {
    const html = entitiesToHtml('a<b>c', [
      { type: 'bold', offset: 0, length: 3 },
      { type: 'italic', offset: 2, length: 3 },
    ]);
    expect(html).toBe('<b>a&lt;<i>b</i></b><i>&gt;c</i>');
  });

  it('supports links, spoilers and quotes; ignores auto-detected entities', () => {
    const html = entitiesToHtml('go here #tag secret', [
      { type: 'text_link', offset: 0, length: 7, url: 'https://t.me/x?a=1&b="2"' },
      { type: 'hashtag', offset: 8, length: 4 },
      { type: 'spoiler', offset: 13, length: 6 },
    ]);
    expect(html).toBe('<a href="https://t.me/x?a=1&amp;b=&quot;2&quot;">go here</a> #tag <tg-spoiler>secret</tg-spoiler>');
    expect(entitiesToHtml('q', [{ type: 'expandable_blockquote', offset: 0, length: 1 }])).toBe('<blockquote expandable>q</blockquote>');
  });

  it('falls back to regular emoji and measures visible length', () => {
    const html = '<tg-emoji emoji-id="1">🔥</tg-emoji> <b>Hi</b> &amp;';
    expect(stripCustomEmoji(html)).toBe('🔥 <b>Hi</b> &amp;');
    expect(visibleLength(html)).toBe('🔥 Hi _'.length);
  });
});
