import type { ChatId, JobScheduler, SendOptions, SentMessage, TelegramGateway } from '../../src/modules/contracts.js';
import { createLogger } from '../../src/lib/logger.js';

export const silentLogger = createLogger('silent' as 'fatal', false);

export interface RecordedCall {
  method: string;
  chatId?: ChatId;
  args: unknown[];
}

/** Telegram error shaped like Telegraf's TelegramError. */
export function telegramError(code: number, description: string, retryAfter?: number): Error {
  const error = new Error(`${code}: ${description}`) as Error & { response: unknown; code: number; description: string };
  error.response = { ok: false, error_code: code, description, ...(retryAfter ? { parameters: { retry_after: retryAfter } } : {}) };
  error.code = code;
  error.description = description;
  return error;
}

/** In-memory Telegram gateway: records calls; failures can be queued per method. */
export class FakeTelegram implements TelegramGateway {
  readonly calls: RecordedCall[] = [];
  readonly files = new Map<string, Buffer>();
  private nextMessageId = 1000;
  private readonly failures = new Map<string, unknown[]>();

  failNext(method: string, ...errors: unknown[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...errors]);
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private record(method: string, chatId: ChatId | undefined, args: unknown[]): void {
    this.calls.push({ method, ...(chatId === undefined ? {} : { chatId }), args });
    const queued = this.failures.get(method);
    if (queued && queued.length > 0) throw queued.shift();
  }

  async sendMessage(chatId: ChatId, text: string, options?: SendOptions): Promise<SentMessage> {
    this.record('sendMessage', chatId, [text, options]);
    return { message_id: this.nextMessageId++ };
  }

  async sendPhoto(chatId: ChatId, photo: string | Buffer, options?: SendOptions): Promise<SentMessage> {
    this.record('sendPhoto', chatId, [photo, options]);
    const id = this.nextMessageId++;
    return { message_id: id, photo: [{ file_id: `photo-file-${id}`, file_unique_id: `unique-${id}`, width: 800, height: 600 }] };
  }

  async copyMessage(chatId: ChatId, fromChatId: ChatId, messageId: number): Promise<void> {
    this.record('copyMessage', chatId, [fromChatId, messageId]);
  }

  async deleteMessage(chatId: ChatId, messageId: number): Promise<void> {
    this.record('deleteMessage', chatId, [messageId]);
  }

  async editMessageReplyMarkup(chatId: ChatId, messageId: number, markup: unknown): Promise<void> {
    this.record('editMessageReplyMarkup', chatId, [messageId, markup]);
  }

  async refundStarPayment(userId: number, telegramChargeId: string): Promise<void> {
    this.record('refundStarPayment', userId, [telegramChargeId]);
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    this.record('downloadFile', undefined, [fileId]);
    const file = this.files.get(fileId);
    if (!file) throw telegramError(400, 'Bad Request: invalid file_id');
    return file;
  }
}

export class FakeScheduler implements JobScheduler {
  readonly publications: number[] = [];
  readonly voteRefreshes: number[] = [];
  readonly broadcasts: number[] = [];
  ticks = 0;

  async enqueuePublication(queueItemId: number): Promise<void> {
    this.publications.push(queueItemId);
  }
  async scheduleVoteRefresh(photoId: number): Promise<void> {
    this.voteRefreshes.push(photoId);
  }
  async enqueueBroadcast(broadcastId: number): Promise<void> {
    this.broadcasts.push(broadcastId);
  }
  async triggerPublishTick(): Promise<void> {
    this.ticks += 1;
  }
}
