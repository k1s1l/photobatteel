import { escapeHtml } from './format.js';

/** Minimal shape of a Telegram MessageEntity. */
export interface TextEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  custom_emoji_id?: string;
  user?: { id: number };
}

function href(url: string): string {
  return escapeHtml(url).replace(/"/g, '&quot;');
}

function tags(entity: TextEntity, text: string): [string, string] | null {
  const value = text.slice(entity.offset, entity.offset + entity.length);
  switch (entity.type) {
    case 'url':
      // Telegram does not always re-detect links in bot messages, so keep them explicitly.
      return [`<a href="${href(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)}">`, '</a>'];
    case 'email':
      return [`<a href="${href(`mailto:${value}`)}">`, '</a>'];
    case 'bold':
      return ['<b>', '</b>'];
    case 'italic':
      return ['<i>', '</i>'];
    case 'underline':
      return ['<u>', '</u>'];
    case 'strikethrough':
      return ['<s>', '</s>'];
    case 'spoiler':
      return ['<tg-spoiler>', '</tg-spoiler>'];
    case 'code':
      return ['<code>', '</code>'];
    case 'pre':
      return entity.language ? [`<pre><code class="language-${escapeHtml(entity.language)}">`, '</code></pre>'] : ['<pre>', '</pre>'];
    case 'text_link':
      return entity.url ? [`<a href="${href(entity.url)}">`, '</a>'] : null;
    case 'text_mention':
      return entity.user ? [`<a href="tg://user?id=${entity.user.id}">`, '</a>'] : null;
    case 'custom_emoji':
      return entity.custom_emoji_id ? [`<tg-emoji emoji-id="${escapeHtml(entity.custom_emoji_id)}">`, '</tg-emoji>'] : null;
    case 'blockquote':
      return ['<blockquote>', '</blockquote>'];
    case 'expandable_blockquote':
      return ['<blockquote expandable>', '</blockquote>'];
    default:
      // mention, hashtag, … are detected by Telegram automatically.
      return null;
  }
}

/**
 * Converts a Telegram message (text + entities) to HTML for parse_mode=HTML,
 * keeping formatting and premium (custom) emoji. Overlapping entities are
 * closed and reopened so the result is always well-formed.
 */
export function entitiesToHtml(text: string, entities: readonly TextEntity[] = []): string {
  const items = entities
    .map((entity, index) => ({ entity, index, tag: tags(entity, text), end: entity.offset + entity.length }))
    .filter((item): item is typeof item & { tag: [string, string] } => item.tag !== null && item.entity.length > 0)
    .sort((a, b) => a.entity.offset - b.entity.offset || b.entity.length - a.entity.length || a.index - b.index);

  let html = '';
  const open: typeof items = [];
  let next = 0;
  for (let i = 0; i <= text.length; i += 1) {
    // Close everything that ends here; reopen entities that were closed only to keep nesting valid.
    if (open.some((item) => item.end === i)) {
      const reopen: typeof items = [];
      while (open.length > 0) {
        const top = open.pop()!;
        html += top.tag[1];
        if (top.end !== i) reopen.unshift(top);
        if (!open.some((item) => item.end === i)) break;
      }
      for (const item of reopen) {
        html += item.tag[0];
        open.push(item);
      }
    }
    while (next < items.length && items[next]!.entity.offset === i) {
      const item = items[next]!;
      html += item.tag[0];
      open.push(item);
      next += 1;
    }
    if (i < text.length) html += escapeHtml(text[i]!);
  }
  return html;
}

/** Replaces premium emoji with their regular fallback (for chats where custom emoji are not allowed). */
export function stripCustomEmoji(html: string): string {
  return html.replace(/<tg-emoji emoji-id="[^"]*">([\s\S]*?)<\/tg-emoji>/g, '$1');
}

/** Visible length of an HTML caption (Telegram limits captions to 1024 characters). */
export function visibleLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot);/g, '_').length;
}

/** http(s) links and bare t.me links in visible text. */
const BARE_LINK = /(?:https?:\/\/|\bt\.me\/)[^\s<>"]+/gi;

/**
 * Makes plain links in an HTML message clickable. Telegram does not always
 * detect them in messages sent by a bot, so they are wrapped in <a> explicitly.
 * Links that already are inside <a>…</a> and tag attributes are left as they are.
 */
export function linkifyHtml(html: string): string {
  let insideLink = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a[\s>]/i.test(part)) insideLink += 1;
        else if (/^<\/a>/i.test(part)) insideLink = Math.max(0, insideLink - 1);
        return part;
      }
      if (insideLink > 0) return part;
      return part.replace(BARE_LINK, (match) => {
        const url = match.replace(/[.,!?;:)\]]+$/, '');
        const rest = match.slice(url.length);
        const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        return `<a href="${href.replace(/"/g, '&quot;')}">${url}</a>${rest}`;
      });
    })
    .join('');
}
