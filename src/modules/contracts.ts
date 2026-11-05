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
  replyToMessageId?: number;
}

export interface AlbumItem {
  type: 'photo' | 'video';
  fileId: string;
  /** HTML caption (only the first item of an album should carry one). */
  caption?: string;
}

/** Subset of the Telegram Bot API used by the domain services. */
export interface TelegramGateway {
  sendMessage(chatId: ChatId, text: string, options?: SendOptions): Promise<SentMessage>;
  sendPhoto(chatId: ChatId, photo: string | Buffer, options?: SendOptions): Promise<SentMessage>;
  /** Sends an album; returns the message ids in order. */
  sendMediaGroup(chatId: ChatId, items: AlbumItem[]): Promise<number[]>;
  copyMessage(chatId: ChatId, fromChatId: ChatId, messageId: number): Promise<void>;
  deleteMessage(chatId: ChatId, messageId: number): Promise<void>;
  editMessageReplyMarkup(chatId: ChatId, messageId: number, markup: InlineKeyboardMarkup | undefined): Promise<void>;
  /** True when the user is a member (or admin/owner) of the chat. */
  isChatMember(chatId: ChatId, userId: number): Promise<boolean>;
  /** Returns a successful Telegram Stars payment to the user. */
  refundStarPayment(userId: number, telegramChargeId: string): Promise<void>;
  /** Downloads a file by file_id, rejecting files larger than `maxBytes`. */
  downloadFile(fileId: string, maxBytes: number): Promise<Buffer>;
}

/** Background job scheduling (implemented with BullMQ). */
export interface JobScheduler {
  /** Prepares a duel stage post for the admins (deduplicated per duel and stage). */
  enqueueDuelPrepare(duelId: number, stage: number): Promise<void>;
  scheduleVoteRefresh(duelId: number): Promise<void>;
  enqueueBroadcast(broadcastId: number): Promise<void>;
  /** Runs the tournament tick as soon as possible. */
  triggerTick(): Promise<void>;
  /** Runs the tournament tick at a precise moment (battle start, end of a duel); `key` deduplicates. */
  scheduleTickAt(at: Date, key: string): Promise<void>;
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
