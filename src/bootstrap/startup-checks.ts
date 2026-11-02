import type { Telegram } from 'telegraf';
import type { Logger } from '../lib/logger.js';
import type { ChannelInfo } from '../modules/contracts.js';

/**
 * Resolves the target channel and verifies the bot's rights there, so that
 * misconfiguration is reported at startup instead of on the first publication.
 */
export async function resolveChannel(telegram: Telegram, channelId: string, botId: number, logger: Logger, strict: boolean): Promise<ChannelInfo> {
  let chat;
  try {
    chat = await telegram.getChat(channelId);
  } catch (error) {
    throw new Error(
      `Cannot access channel ${channelId}. Add the bot to the channel as an administrator and check CHANNEL_ID. (${(error as Error).message})`,
    );
  }
  if (chat.type !== 'channel') throw new Error(`CHANNEL_ID ${channelId} is a ${chat.type}, expected a channel`);

  const member = await telegram.getChatMember(chat.id, botId);
  const problems: string[] = [];
  if (member.status !== 'administrator') problems.push('the bot is not an administrator of the channel');
  else {
    if (!member.can_post_messages) problems.push('missing right: Post messages');
    if (!member.can_edit_messages) problems.push('missing right: Edit messages of others (needed for vote counters)');
    if (!member.can_delete_messages) problems.push('missing right: Delete messages of others (needed for deletion requests)');
  }
  if (problems.length > 0) {
    const message = `Channel permission problems: ${problems.join('; ')}`;
    if (strict && member.status !== 'administrator') throw new Error(message);
    logger.warn(message);
  }

  const info: ChannelInfo = { id: chat.id, title: chat.title, username: 'username' in chat ? chat.username : undefined };
  logger.info({ channelId: info.id, title: info.title, username: info.username }, 'Channel resolved');
  return info;
}
