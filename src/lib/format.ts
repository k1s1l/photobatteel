/** Public photo identifier shown to users and in the channel: #0001. */
export function formatPhotoId(id: number): string {
  return `#${String(id).padStart(4, '0')}`;
}

/** Parses "#0001", "0001", "1" into a photo id. */
export function parsePhotoId(input: string): number | null {
  const match = /^#?\s*(\d{1,9})$/.exec(input.trim());
  if (!match?.[1]) return null;
  const id = Number(match[1]);
  return id > 0 ? id : null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface NamedUser {
  username: string | null;
  firstName: string;
  lastName: string | null;
}

/** "@username" when available, otherwise the display name. Returns plain (unescaped) text. */
export function displayName(user: NamedUser): string {
  if (user.username) return `@${user.username}`;
  const full = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return full || '👤';
}

export function formatDateTime(date: Date, timeZone: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** "16:00" in the given time zone. */
export function formatTime(date: Date, timeZone: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function formatDate(date: Date, timeZone: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

/** Link to a channel post. Private channels get a t.me/c/ link (works for members). */
export function channelPostLink(channel: { id: number; username?: string | undefined }, messageId: number): string {
  if (channel.username) return `https://t.me/${channel.username}/${messageId}`;
  const internalId = String(channel.id).replace(/^-100/, '');
  return `https://t.me/c/${internalId}/${messageId}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
