import { describe, expect, it } from 'vitest';
import { channelPostLink, displayName, escapeHtml, formatPhotoId, parsePhotoId } from '../../src/lib/format.js';

describe('format helpers', () => {
  it('formats and parses photo ids', () => {
    expect(formatPhotoId(1)).toBe('#0001');
    expect(formatPhotoId(12345)).toBe('#12345');
    expect(parsePhotoId('#0012')).toBe(12);
    expect(parsePhotoId(' 7 ')).toBe(7);
    expect(parsePhotoId('#0')).toBeNull();
    expect(parsePhotoId('abc')).toBeNull();
    expect(parsePhotoId('#12; DROP TABLE')).toBeNull();
  });

  it('uses @username or falls back to the display name', () => {
    expect(displayName({ username: 'kate', firstName: 'Kate', lastName: null })).toBe('@kate');
    expect(displayName({ username: null, firstName: 'Kate', lastName: 'Smith' })).toBe('Kate Smith');
    expect(displayName({ username: null, firstName: '', lastName: null })).toBe('👤');
  });

  it('escapes HTML', () => {
    expect(escapeHtml('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
  });

  it('builds links for public and private channels', () => {
    expect(channelPostLink({ id: -1001234, username: 'pb' }, 5)).toBe('https://t.me/pb/5');
    expect(channelPostLink({ id: -1001234567 }, 5)).toBe('https://t.me/c/1234567/5');
  });
});
