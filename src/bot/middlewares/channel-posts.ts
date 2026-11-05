import type { MiddlewareFn } from 'telegraf';
import type { BotContext } from '../context.js';

/**
 * New posts in the battle channel. When an admin publishes a prepared duel post
 * (forwarded from the bot), the bot recognises its files and attaches the vote
 * buttons under it. Posts in other channels are ignored.
 */
export const channelPosts: MiddlewareFn<BotContext> = async (ctx, next) => {
  const post = ctx.channelPost;
  if (!post) return next();
  if (ctx.chat?.id !== ctx.deps.channel.id) return;
  const fileUniqueIds = [
    ...('photo' in post ? post.photo.map((size) => size.file_unique_id) : []),
    ...('video' in post ? [post.video.file_unique_id] : []),
  ];
  await ctx.deps.services.battles.linkChannelPost({ messageId: post.message_id, fileUniqueIds });
};
