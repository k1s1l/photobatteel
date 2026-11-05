import type { AlbumItem, ChatId, JobScheduler, SendOptions, SentMessage, TelegramGateway } from '../../src/modules/contracts.js';
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
  /** Telegram ids that are NOT channel members (everyone else is). */
  readonly nonMembers = new Set<number>();
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

  /** file_id → file_unique_id of photos "uploaded" so far (re-sending by file_id keeps the unique id, as in Telegram). */
  private readonly uploaded = new Map<string, string>();

  async sendPhoto(chatId: ChatId, photo: string | Buffer, options?: SendOptions): Promise<SentMessage> {
    this.record('sendPhoto', chatId, [photo, options]);
    const id = this.nextMessageId++;
    const known = typeof photo === 'string' ? this.uploaded.get(photo) : undefined;
    const fileId = known ? (photo as string) : `photo-file-${id}`;
    const uniqueId = known ?? `unique-${id}`;
    this.uploaded.set(fileId, uniqueId);
    return { message_id: id, photo: [{ file_id: fileId, file_unique_id: uniqueId, width: 800, height: 600 }] };
  }

  /** A new message id, as if someone posted in a chat. */
  nextId(): number {
    return this.nextMessageId++;
  }

  async sendMediaGroup(chatId: ChatId, items: AlbumItem[]): Promise<number[]> {
    this.record('sendMediaGroup', chatId, [items]);
    return items.map(() => this.nextMessageId++);
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

  async isChatMember(chatId: ChatId, userId: number): Promise<boolean> {
    this.record('isChatMember', chatId, [userId]);
    return !this.nonMembers.has(userId);
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
  readonly duelPosts: { duelId: number; stage: number }[] = [];
  readonly voteRefreshes: number[] = [];
  readonly broadcasts: number[] = [];
  ticks = 0;

  async enqueueDuelPrepare(duelId: number, stage: number): Promise<void> {
    this.duelPosts.push({ duelId, stage });
  }
  async scheduleVoteRefresh(duelId: number): Promise<void> {
    this.voteRefreshes.push(duelId);
  }
  async enqueueBroadcast(broadcastId: number): Promise<void> {
    this.broadcasts.push(broadcastId);
  }
  async triggerTick(): Promise<void> {
    this.ticks += 1;
  }
  readonly timedTicks: { at: Date; key: string }[] = [];
  async scheduleTickAt(at: Date, key: string): Promise<void> {
    this.timedTicks.push({ at, key });
  }
}
