import type { MiddlewareFn } from 'telegraf';
import { escapeHtml } from '../../lib/format.js';
import type { BotContext } from '../context.js';

/**
 * New posts in the battle channel. When an admin publishes a prepared duel post
 * (forwarded from the bot), the bot recognises its files and attaches the vote
 * buttons under it. A prepared post published in another channel triggers a hint to the admins.
 */
export const channelPosts: MiddlewareFn<BotContext> = async (ctx, next) => {
  const post = ctx.channelPost;
  if (!post) return next();
  const fileUniqueIds = [
    ...('photo' in post ? post.photo.map((size) => size.file_unique_id) : []),
    ...('video' in post ? [post.video.file_unique_id] : []),
  ];
  const { battles, notifications } = ctx.deps.services;
  if (ctx.chat?.id !== ctx.deps.channel.id) {
    // A prepared duel post published in another channel: tell the admins why no buttons appeared.
    if (await battles.isPreparedPost(fileUniqueIds)) {
      const title = ctx.chat && 'title' in ctx.chat ? ctx.chat.title : String(ctx.chat?.id);
      const expected = ctx.deps.channel.username ? `@${ctx.deps.channel.username}` : (ctx.deps.channel.title ?? String(ctx.deps.channel.id));
      await notifications.notifyAdmins((l) => l.admin.wrongChannel({ got: escapeHtml(title), expected: escapeHtml(expected) }));
    }
    return;
  }
  await battles.linkChannelPost({ messageId: post.message_id, fileUniqueIds });
};
