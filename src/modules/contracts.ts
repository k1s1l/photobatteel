import type { InlineKeyboardMarkup } from 'telegraf/types';

export type ChatId = number | string;

export interface SentMessage {
  message_id: number;
  /** Present when a photo was sent: available sizes, largest last. */
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[];
}

export interface SendOptions {
  caption?: string;
  parseMode?: 'HTML';
  replyMarkup?: InlineKeyboardMarkup;
  disablePreview?: boolean;
}

/** Subset of the Telegram Bot API used by the domain services. */
export interface TelegramGateway {
  sendMessage(chatId: ChatId, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: ChatId, photo: string | Buffer, options?: SendOptions): Promise<SentMessage>;
  copyMessage(chatId: ChatId, fromChatId: ChatId, messageId: number): Promise<void>;
  deleteMessage(chatId: ChatId, messageId: number): Promise<void>;
  editMessageReplyMarkup(chatId: ChatId, messageId: number, markup: InlineKeyboardMarkup | undefined): Promise<void>;
  /** Downloads a file by file_id, rejecting files larger than `maxBytes`. */
  downloadFile(fileId: string, maxBytes: number): Promise<Buffer>;
}

/** Background job scheduling (implemented with BullMQ). */
export interface JobScheduler {
  enqueuePublication(queueItemId: number): Promise<void>;
  scheduleVoteRefresh(photoId: number): Promise<void>;
  enqueueBroadcast(broadcastId: number): Promise<void>;
  triggerPublishTick(): Promise<void>;
}

/** The target channel, resolved at startup. */
export interface ChannelInfo {
  id: number;
  username?: string | undefined;
  title?: string | undefined;
}

export interface BotIdentity {
  username: string;
}
