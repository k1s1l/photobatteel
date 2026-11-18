import { describe, expect, it } from 'vitest';
import type { Message } from 'telegraf/types';
import { channelPostId } from '../../src/bot/handlers/admin/final-spots.js';

const channel = { id: -1001234567890, username: 'clashbattle' };
const text = (value: string) => ({ message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: value }) as unknown as Message;

describe('channelPostId', () => {
  it('reads a post forwarded from the channel', () => {
    const message = { ...text('x'), forward_origin: { type: 'channel', chat: { id: channel.id, type: 'channel', title: 'c' }, message_id: 77, date: 0 } } as unknown as Message;
    expect(channelPostId(message, channel)).toBe(77);
  });

  it('ignores posts from other channels', () => {
    const message = { ...text('x'), forward_origin: { type: 'channel', chat: { id: -100999, type: 'channel', title: 'c' }, message_id: 77, date: 0 } } as unknown as Message;
    expect(channelPostId(message, channel)).toBeNull();
  });

  it('reads private and public post links', () => {
    expect(channelPostId(text('https://t.me/c/1234567890/45'), channel)).toBe(45);
    expect(channelPostId(text('t.me/clashbattle/46?single'), channel)).toBe(46);
    expect(channelPostId(text('https://t.me/c/555/45'), channel)).toBeNull();
  });

  it('treats a regular message as a new post', () => {
    expect(channelPostId(text('Место в финале — 25 ⭐'), channel)).toBeNull();
  });
});
