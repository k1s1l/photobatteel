import { describe, expect, it } from 'vitest';
import { parseStartTime, zonedTimeToUtc } from '../../src/lib/time.js';

const TZ = 'Europe/Kyiv';

describe('start time parsing (bot time zone)', () => {
  it('converts wall-clock time in Kyiv to UTC, including DST', () => {
    expect(zonedTimeToUtc(2026, 11, 5, 14, 0, TZ).toISOString()).toBe('2026-11-05T12:00:00.000Z'); // winter, UTC+2
    expect(zonedTimeToUtc(2026, 7, 5, 14, 0, TZ).toISOString()).toBe('2026-07-05T11:00:00.000Z'); // summer, UTC+3
  });

  it('parses "HH:MM" as today, or tomorrow when the time has passed', () => {
    const now = new Date('2026-11-05T10:00:00Z'); // 12:00 in Kyiv
    expect(parseStartTime('14:00', TZ, now)?.toISOString()).toBe('2026-11-05T12:00:00.000Z');
    expect(parseStartTime('09:30', TZ, now)?.toISOString()).toBe('2026-11-06T07:30:00.000Z');
    expect(parseStartTime('14.00', TZ, now)?.toISOString()).toBe('2026-11-05T12:00:00.000Z');
  });

  it('parses dates with and without a year', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    expect(parseStartTime('06.11 14:00', TZ, now)?.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    expect(parseStartTime('01.01 00:05', TZ, now)?.toISOString()).toBe('2026-12-31T22:05:00.000Z');
    expect(parseStartTime('10.12.2026 18:30', TZ, now)?.toISOString()).toBe('2026-12-10T16:30:00.000Z');
  });

  it('rejects invalid or past times', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    for (const input of ['25:00', '12:61', 'tomorrow', '31.02 10:00', '01.01.2020 10:00', '']) {
      expect(parseStartTime(input, TZ, now), input).toBeNull();
    }
  });
});
