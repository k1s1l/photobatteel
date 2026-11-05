/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to an instant (handles DST). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  result = guess - zoneOffsetMs(new Date(result), timeZone);
  return new Date(result);
}

function zonedDate(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * Parses an admin-entered start time in the bot's time zone:
 * "14:00" (today, or tomorrow if already past), "06.11 14:00", "06.11.2026 14:00".
 * Returns null for invalid input or a time in the past.
 */
export function parseStartTime(input: string, timeZone: string, now: Date = new Date()): Date | null {
  const match = /^\s*(?:(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+)?(\d{1,2})[:.](\d{2})\s*$/.exec(input);
  if (!match) return null;
  const [, dd, mm, yyyy, hh, min] = match;
  const hour = Number(hh);
  const minute = Number(min);
  if (hour > 23 || minute > 59) return null;

  const today = zonedDate(now, timeZone);
  if (!dd) {
    let candidate = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
    if (candidate <= now) {
      const tomorrow = zonedDate(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
      candidate = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timeZone);
    }
    return candidate;
  }
  const day = Number(dd);
  const month = Number(mm);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = yyyy ? Number(yyyy) : today.year;
  let candidate = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  if (!yyyy && candidate <= now) {
    year += 1;
    candidate = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  }
  // Reject impossible dates such as 31.02 (Date.UTC would roll them over).
  const check = zonedDate(candidate, timeZone);
  if (check.day !== day || check.month !== month) return null;
  return candidate > now ? candidate : null;
}
