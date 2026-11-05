import type { Telegram } from 'telegraf';
import { DomainError } from '../lib/errors.js';
import type { AlbumItem, ChatId, SendOptions, SentMessage, TelegramGateway } from '../modules/contracts.js';

const DOWNLOAD_TIMEOUT_MS = 30_000;

function extra(options: SendOptions = {}) {
  return {
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    ...(options.disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
    ...(options.replyToMessageId ? { reply_parameters: { message_id: options.replyToMessageId, allow_sending_without_reply: true } } : {}),
  };
}

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

/** TelegramGateway implementation on top of Telegraf's API client. */
export class TelegrafGateway implements TelegramGateway {
  constructor(private readonly telegram: Telegram) {}

  async sendMessage(chatId: ChatId, text: string, options?: SendOptions): Promise<SentMessage> {
    const message = await this.telegram.sendMessage(chatId, text, extra(options));
    return { message_id: message.message_id };
  }

  async sendPhoto(chatId: ChatId, photo: string | Buffer, options: SendOptions = {}): Promise<SentMessage> {
    const input = typeof photo === 'string' ? photo : { source: photo, filename: 'photo.jpg' };
    const { link_preview_options: _ignored, ...rest } = extra(options);
    const message = await this.telegram.sendPhoto(chatId, input, { ...rest, ...(options.caption ? { caption: options.caption } : {}) });
    return { message_id: message.message_id, photo: message.photo };
  }

  async sendMediaGroup(chatId: ChatId, items: AlbumItem[]): Promise<number[]> {
    const media = items.map((item) => ({ type: item.type, media: item.fileId, ...(item.caption ? { caption: item.caption, parse_mode: 'HTML' } : {}) }));
    const messages = await this.telegram.sendMediaGroup(chatId, media as Parameters<Telegram['sendMediaGroup']>[1]);
    return messages.map((message) => message.message_id);
  }

  async isChatMember(chatId: ChatId, userId: number): Promise<boolean> {
    const member = await this.telegram.getChatMember(chatId, userId);
    if (MEMBER_STATUSES.has(member.status)) return true;
    return member.status === 'restricted' && member.is_member;
  }

  async copyMessage(chatId: ChatId, fromChatId: ChatId, messageId: number): Promise<void> {
    await this.telegram.copyMessage(chatId, fromChatId, messageId);
  }

  async deleteMessage(chatId: ChatId, messageId: number): Promise<void> {
    await this.telegram.deleteMessage(chatId, messageId);
  }

  async editMessageReplyMarkup(chatId: ChatId, messageId: number, markup: SendOptions['replyMarkup']): Promise<void> {
    await this.telegram.editMessageReplyMarkup(chatId, messageId, undefined, markup);
  }

  async refundStarPayment(userId: number, telegramChargeId: string): Promise<void> {
    // Not yet typed in Telegraf 4.16; the Bot API method is stable.
    const call = this.telegram.callApi as unknown as (method: string, payload: Record<string, unknown>) => Promise<unknown>;
    await call.call(this.telegram, 'refundStarPayment', { user_id: userId, telegram_payment_charge_id: telegramChargeId });
  }

  async downloadFile(fileId: string, maxBytes: number): Promise<Buffer> {
    const file = await this.telegram.getFile(fileId);
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    if (file.file_size !== undefined && file.file_size > maxBytes) throw new DomainError('FILE_TOO_LARGE', { maxMb });
    if (!file.file_path) throw new DomainError('INVALID_IMAGE');

    const url = await this.telegram.getFileLink(file);
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`File download failed with HTTP ${response.status}`);

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new DomainError('FILE_TOO_LARGE', { maxMb });
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
