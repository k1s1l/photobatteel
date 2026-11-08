import { Redis } from 'ioredis';
import { Telegraf, Telegram } from 'telegraf';
import type { Update } from 'telegraf/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../../src/bot/bot.js';
import type { BotContext } from '../../src/bot/context.js';
import { parseEnv } from '../../src/config/env.js';
import { LockService } from '../../src/lib/locks.js';
import { ADMIN_TG_ID, CHANNEL, createEntry, createTestContext, createUser, openBattle, postPendingDuels, preparePendingDuels, startBattle, type TestContext } from '../helpers/context.js';
import { TEST_REDIS_URL } from '../helpers/env.js';
import { silentLogger } from '../helpers/fakes.js';
import { makeJpeg, makeUniqueJpeg } from '../helpers/images.js';

const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
afterAll(() => redis.disconnect());

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

let ctx: TestContext;
let bot: Telegraf<BotContext>;
let api: ApiCall[];
let updateId = 1;
let messageId = 5000;

const env = parseEnv({
  BOT_TOKEN: '123456789:AAFakeTokenForTestingPurposesOnly_1234',
  CHANNEL_ID: String(CHANNEL.id),
  DATABASE_URL: 'postgresql://unused@localhost/test',
  RATE_LIMIT_PER_MINUTE: '1000',
  DEFAULT_LANGUAGE: 'ru',
  PAYMENT_PROVIDER_TOKEN: 'test-provider-token',
});

beforeEach(async () => {
  ctx = await createTestContext();
  await redis.flushdb();
  api = [];
  bot = new Telegraf<BotContext>(env.BOT_TOKEN);
  bot.botInfo = { id: 1, is_bot: true, first_name: 'PB', username: 'photobattle_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } as typeof bot.botInfo;
  // Telegraf creates a Telegram client per update, so the API is intercepted on the prototype.
  vi.restoreAllMocks();
  vi.spyOn(Telegram.prototype, 'callApi').mockImplementation((async (method: string, payload: Record<string, unknown> = {}) => {
    api.push({ method, payload });
    const id = messageId++;
    if (method === 'sendPhoto') return { message_id: id, date: 0, chat: { id: payload.chat_id }, photo: [{ file_id: `preview-${id}`, file_unique_id: `pu-${id}`, width: 800, height: 600 }] };
    if (method === 'sendVideo') return { message_id: id, date: 0, chat: { id: payload.chat_id }, video: { file_id: 'v', file_unique_id: 'vu', width: 1, height: 1, duration: 1 } };
    if (method.startsWith('send') || method === 'copyMessage') return { message_id: id, date: 0, chat: { id: payload.chat_id } };
    return true;
  }) as typeof Telegram.prototype.callApi);
  createBot(bot, { services: ctx.services, locks: new LockService(redis), gateway: ctx.telegram, channel: CHANNEL, logger: silentLogger, env }, redis);
});

function from(id: number, username = `u${id}`, languageCode?: string) {
  return { id, is_bot: false, first_name: `Name${id}`, username, ...(languageCode ? { language_code: languageCode } : {}) };
}

const privateChat = (id: number) => ({ id, type: 'private' as const, first_name: 'N' });

async function sendText(userId: number, text: string, extra: Record<string, unknown> = {}) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId++, date: 0, chat: privateChat(userId), from: from(userId), text, ...(entities ? { entities } : {}), ...extra },
  } as Update);
}

async function sendPhoto(userId: number, fileId: string, fileUniqueId: string) {
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId++, date: 0, chat: privateChat(userId), from: from(userId), photo: [{ file_id: fileId, file_unique_id: fileUniqueId, width: 800, height: 600, file_size: 50_000 }] },
  } as Update);
}

async function sendVideo(userId: number, duration: number) {
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: 0,
      chat: privateChat(userId),
      from: from(userId),
      video: { file_id: `video-${userId}`, file_unique_id: `vu-${userId}`, width: 1280, height: 720, duration, file_size: 5_000_000, mime_type: 'video/mp4' },
    },
  } as Update);
}

async function press(userId: number, data: string, chat: { id: number; type: 'private' | 'channel' } = { id: userId, type: 'private' }) {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: from(userId),
      chat_instance: 'ci',
      data,
      message: { message_id: 1, date: 0, chat: chat.type === 'private' ? privateChat(chat.id) : { id: chat.id, type: 'channel', title: 'C' }, text: 'x' },
    },
  } as Update);
}

const texts = (method: string) => api.filter((c) => c.method === method).map((c) => String(c.payload.text ?? c.payload.caption ?? ''));
const answers = () => api.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.payload.text ?? ''));

async function consent(userId: number) {
  const { user } = await ctx.services.users.upsertFromTelegram({ id: userId, first_name: 'C' });
  await ctx.services.users.giveConsent(user.id);
}

describe('bot: registration and menu', () => {
  it('registers the user on /start and shows the short menu', async () => {
    await sendText(10, '/start');
    expect(await ctx.prisma.user.count({ where: { telegramId: 10n } })).toBe(1);
    const reply = api.find((c) => c.method === 'sendMessage')!;
    expect(String(reply.payload.text)).toContain('Добро пожаловать в Photo Battle! 📸');
    const keyboard = JSON.stringify(reply.payload.reply_markup);
    for (const label of ['📸 Отправить фото или видео', '⭐ Купить голоса', '⚔️ Текущий батл', 'ℹ️ Правила', '❓ Помощь']) expect(keyboard).toContain(label);
    expect(keyboard).not.toContain('Админ-панель');
  });

  it('greets Ukrainian Telegram users in Ukrainian and lets them switch language', async () => {
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: messageId++, date: 0, chat: privateChat(90), from: from(90, 'olena', 'uk'), text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] },
    } as Update);
    expect(texts('sendMessage').at(-1)).toContain('Ласкаво просимо до Photo Battle! 📸');
    await press(90, 'lang:ru');
    expect(texts('sendMessage').at(-1)).toContain('Язык интерфейса: русский');
  });
});

describe('bot: submission', () => {
  it('says submissions are closed when no battle is scheduled', async () => {
    await consent(19);
    await sendText(19, '📸 Отправить фото или видео');
    expect(texts('sendMessage').at(-1)).toContain('приём работ закрыт');
  });

  it('goes consent → photo → preview → confirm, keeps the entry until the start, and ignores a second confirm', async () => {
    await openBattle(ctx);
    ctx.telegram.files.set('tg-file-1', await makeJpeg());
    await sendText(20, '📸 Отправить фото или видео');
    expect(texts('sendMessage').at(-1)).toContain('Согласие на публикацию');
    await press(20, 'consent');
    expect(texts('sendMessage').at(-1)).toContain('для батла «Осень»');

    await sendPhoto(20, 'tg-file-1', 'tg-unique-1');
    const photo = await ctx.prisma.photo.findFirstOrThrow();
    expect(String(api.filter((c) => c.method === 'sendPhoto').at(-1)!.payload.caption)).toContain('Предпросмотр');
    await press(20, `ph:ok:${photo.id}`);
    expect(texts('sendMessage').some((t) => t.includes('Работа принята в батл «Осень»'))).toBe(true);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('ACCEPTED');

    await press(20, `ph:ok:${photo.id}`);
    expect(answers().at(-1)).toBe('Это действие уже выполнено.');
    expect(ctx.telegram.callsOf('sendPhoto')).toHaveLength(0); // nothing posted to the channel yet
  });

  it('accepts videos and rejects ones that are too long', async () => {
    await openBattle(ctx);
    await consent(21);
    await sendVideo(21, 999);
    expect(texts('sendMessage').at(-1)).toContain('Видео слишком длинное');
    await sendVideo(21, 30);
    expect(api.some((c) => c.method === 'sendVideo' && String(c.payload.caption).includes('Предпросмотр'))).toBe(true);
    expect(await ctx.prisma.photo.findFirstOrThrow()).toMatchObject({ mediaType: 'VIDEO', durationSec: 30, status: 'DRAFT' });
  });

  it('rejects non-media and corrupted files with a clear message', async () => {
    await openBattle(ctx);
    ctx.telegram.files.set('broken', (await makeUniqueJpeg(1)).subarray(0, 200));
    await consent(30);
    await sendText(30, '📸 Отправить фото или видео');
    await sendText(30, 'hello');
    expect(texts('sendMessage').at(-1)).toContain('Это не фото и не видео');
    await sendPhoto(30, 'broken', 'broken-u');
    expect(texts('sendMessage').at(-1)).toContain('Не удалось прочитать изображение');
  });
});

describe('bot: voting under duel posts', () => {
  async function runningDuel() {
    const battle = await openBattle(ctx);
    for (const userId of [60, 61]) {
      await consent(userId);
      ctx.telegram.files.set(`p${userId}`, await makeUniqueJpeg(userId));
      await sendPhoto(userId, `p${userId}`, `pu${userId}`);
      const photo = await ctx.prisma.photo.findFirstOrThrow({ where: { user: { telegramId: BigInt(userId) } } });
      await press(userId, `ph:ok:${photo.id}`);
    }
    await startBattle(ctx, battle.id);
    await postPendingDuels(ctx);
    return ctx.prisma.duel.findFirstOrThrow();
  }

  it('attaches vote buttons when the admin forwards the prepared post to the channel', async () => {
    const battle = await openBattle(ctx);
    for (const userId of [62, 63]) {
      await consent(userId);
      ctx.telegram.files.set(`p${userId}`, await makeUniqueJpeg(userId));
      await sendPhoto(userId, `p${userId}`, `pu${userId}`);
      const photo = await ctx.prisma.photo.findFirstOrThrow({ where: { user: { telegramId: BigInt(userId) } } });
      await press(userId, `ph:ok:${photo.id}`);
    }
    await startBattle(ctx, battle.id);
    await preparePendingDuels(ctx);
    const duel = await ctx.prisma.duel.findFirstOrThrow();
    // Posts in other channels are ignored.
    await bot.handleUpdate({
      update_id: updateId++,
      channel_post: { message_id: 1, date: 0, chat: { id: -1009999, type: 'channel', title: 'Other' }, photo: [{ file_id: 'x', file_unique_id: duel.preparedFileUniqueId!, width: 1, height: 1 }] },
    } as Update);
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).status).toBe('READY');
    expect(ctx.telegram.callsOf('sendMessage').some((c) => c.chatId === ADMIN_TG_ID && String(c.args[0]).includes('опубликован в канале «Other»'))).toBe(true);

    await bot.handleUpdate({
      update_id: updateId++,
      channel_post: {
        message_id: 777,
        date: 0,
        chat: { id: CHANNEL.id, type: 'channel', title: 'C' },
        photo: [
          { file_id: 'small', file_unique_id: 'small-u', width: 90, height: 60 },
          { file_id: 'big', file_unique_id: duel.preparedFileUniqueId!, width: 1452, height: 900 },
        ],
        caption: 'designed caption',
      },
    } as Update);
    const live = await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } });
    expect(live).toMatchObject({ status: 'ACTIVE', mediaMessageIds: [777] });
    const buttons = ctx.telegram.callsOf('sendMessage').find((c) => c.chatId === CHANNEL.id)!;
    expect((buttons.args[1] as { replyToMessageId: number }).replyToMessageId).toBe(777);
  });

  it('counts a free vote from a channel subscriber and lets them switch', async () => {
    const duel = await runningDuel();
    await press(70, `d:${duel.id}:0:a`, { id: CHANNEL.id, type: 'channel' });
    expect(answers().at(-1)).toContain('Голос за работу 1 учтён');
    await press(70, `d:${duel.id}:0:b`, { id: CHANNEL.id, type: 'channel' });
    expect(await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).toMatchObject({ votesA: 0, votesB: 1 });
  });

  it('asks non-subscribers to subscribe', async () => {
    const duel = await runningDuel();
    ctx.telegram.nonMembers.add(71);
    await press(71, `d:${duel.id}:0:a`, { id: CHANNEL.id, type: 'channel' });
    expect(answers().at(-1)).toContain('Голосовать могут только подписчики');
  });

  it('"⭐ +1" opens the bot, lets the user pick a side and pay with Stars', async () => {
    await ctx.services.settings.update({ paidVotesEnabled: true }, null);
    const duel = await runningDuel();
    await press(72, `dp:${duel.id}`, { id: CHANNEL.id, type: 'channel' });
    expect(api.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.payload.url).toBe(`https://t.me/photobattle_bot?start=duel_${duel.id}`);

    await sendText(72, `/start duel_${duel.id}`);
    expect(texts('sendMessage').at(-1)).toContain('За какую работу?');
    await press(72, `pay:side:${duel.id}:b`);
    expect(texts('sendMessage').at(-1)).toContain('Голоса за работу 2');
    const [pack] = await ctx.services.payments.listPackages(true);
    await press(72, `pay:s:${pack!.id}:${duel.photoBId}`);
    const invoice = api.find((c) => c.method === 'sendInvoice')!;
    expect(invoice.payload).toMatchObject({ currency: 'XTR', provider_token: '', prices: [{ amount: pack!.priceStars }] });
    expect(String(invoice.payload.description)).toContain('работу 2');

    await bot.handleUpdate({
      update_id: updateId++,
      pre_checkout_query: { id: 'pcq1', from: from(72), currency: 'XTR', total_amount: pack!.priceStars, invoice_payload: String(invoice.payload.payload) },
    } as Update);
    expect(api.find((c) => c.method === 'answerPreCheckoutQuery')?.payload).toMatchObject({ ok: true });
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId++,
        date: 0,
        chat: privateChat(72),
        from: from(72),
        successful_payment: { currency: 'XTR', total_amount: pack!.priceStars, invoice_payload: String(invoice.payload.payload), telegram_payment_charge_id: 'c1', provider_payment_charge_id: '' },
      },
    } as Update);
    expect(texts('sendMessage').at(-1)).toContain('Работа получила +5');
    expect((await ctx.prisma.duel.findUniqueOrThrow({ where: { id: duel.id } })).votesB).toBe(5);
  });
});

describe('bot: card transfer', () => {
  it('shows transfer details with a code and accepts "I paid" (manual check)', async () => {
    await ctx.services.settings.update({ paidVotesEnabled: true, transferEnabled: true, transferDetails: 'monobank jar link' }, null);
    // No Telegram payment provider in this test: the card button leads to a transfer.
    const services = ctx.services as unknown as { payments: { options: { cardEnabled: boolean } } };
    services.payments.options.cardEnabled = false;
    await sendText(80, '⭐ Купить голоса');
    const [pack] = await ctx.services.payments.listPackages(true);
    expect(JSON.stringify(api.filter((c) => c.method === 'sendMessage').at(-1)!.payload.reply_markup)).toContain(`pay:t:${pack!.id}:0`);

    await press(80, `pay:t:${pack!.id}:0`);
    const instructions = texts('sendMessage').at(-1)!;
    const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { method: 'TRANSFER' } });
    expect(instructions).toContain(payment.code!);
    expect(instructions).toContain('monobank jar link');
    await press(80, `pay:tc:${payment.id}`);
    expect(texts('sendMessage').at(-1)).toContain('Администратор проверит перевод');
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('CLAIMED');
  });
});

describe('bot: admin', () => {
  it('denies admin buttons and commands to regular users', async () => {
    await press(40, 'a:stats');
    expect(answers().at(-1)).toContain('нет доступа');
    await sendText(40, '/admin');
    expect(texts('sendMessage').at(-1)).toContain('нет доступа');
    expect(await ctx.prisma.activityLog.count({ where: { action: 'ADMIN_ACCESS_DENIED' } })).toBe(2);
  });

  it('schedules a battle: start time → round duration → final duration (named automatically)', async () => {
    await sendText(ADMIN_TG_ID, '/admin');
    expect(texts('sendMessage').at(-1)).toContain('Админ-панель Photo Battle');
    await press(ADMIN_TG_ID, 'a:bt:new');
    expect(texts('editMessageText').at(-1)).toContain('Когда старт');
    await sendText(ADMIN_TG_ID, 'вчера');
    expect(texts('sendMessage').at(-1)).toContain('Не понял время');
    await sendText(ADMIN_TG_ID, '23:59');
    expect(texts('sendMessage').at(-1)).toContain('Сколько длится голосование');
    await press(ADMIN_TG_ID, 'a:bt:round:120');
    expect(texts('editMessageText').at(-1)).toContain('голосование в финале');
    await press(ADMIN_TG_ID, 'a:bt:final:360');
    expect(texts('editMessageText').at(-1)).toContain('Сколько работ будет в финале');
    await press(ADMIN_TG_ID, 'a:bt:size:3');
    const battle = await ctx.prisma.battle.findFirstOrThrow();
    expect(battle).toMatchObject({ title: 'Фотобатл #1', status: 'SCHEDULED', roundMinutes: 120, finalMinutes: 360, tiebreakMinutes: 10, finalSize: 3 });
    expect(battle.startsAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('saves a duel design with premium emoji from a formatted message', async () => {
    await press(ADMIN_TG_ID, 'a:tpl');
    expect(texts('editMessageText').some((t) => t.includes('Оформление постов'))).toBe(true);
    await press(ADMIN_TG_ID, 'a:tpl:k:duel');
    await press(ADMIN_TG_ID, 'a:tpl:up:duel');
    await sendText(ADMIN_TG_ID, '🔥 БАТЛ {stage}', {
      entities: [
        { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5368324170671202286' },
        { type: 'bold', offset: 3, length: 4 },
      ],
    });
    expect((await ctx.services.settings.get()).duelTemplate).toBe('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> <b>БАТЛ</b> {stage}');
    expect(texts('sendMessage').some((t) => t.includes('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> <b>БАТЛ</b> Раунд 1 · Пара 3'))).toBe(true);
  });

  it('saves a separate design for the final buttons message', async () => {
    await press(ADMIN_TG_ID, 'a:tpl:k:buttons');
    expect(texts('editMessageText').at(-1)).toContain('Раунд 1–4 или Финал');
    await press(ADMIN_TG_ID, 'a:tpl:v:buttons:final');
    await press(ADMIN_TG_ID, 'a:tpl:up:buttons:final');
    await sendText(ADMIN_TG_ID, 'Ф ИНАЛ {stage}', { entities: [{ type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: '77' }] });
    const settings = await ctx.services.settings.get();
    expect(settings.stageTemplates).toEqual({ 'buttons:final': '<tg-emoji emoji-id="77">Ф</tg-emoji> ИНАЛ {stage}' });
    expect(settings.buttonsTemplate).toBeNull();
    expect(texts('sendMessage').some((t) => t === '<tg-emoji emoji-id="77">Ф</tg-emoji> ИНАЛ Финал')).toBe(true);
    await press(ADMIN_TG_ID, 'a:tpl:reset:buttons:final');
    expect((await ctx.services.settings.get()).stageTemplates).toEqual({});
  });

  it('changes the end of the current round from the battles screen', async () => {
    const battle = await openBattle(ctx);
    for (let i = 0; i < 2; i += 1) await createEntry(ctx, await createUser(ctx));
    await startBattle(ctx, battle.id);
    await press(ADMIN_TG_ID, 'a:bt');
    await press(ADMIN_TG_ID, `a:bt:end:${battle.id}`);
    expect(texts('sendMessage').at(-1)).toContain('Конец раунда 1');
    await sendText(ADMIN_TG_ID, '23:58');
    expect(texts('sendMessage').at(-1)).toContain('Раунд 1 закончится');
    expect((await ctx.prisma.battle.findUniqueOrThrow({ where: { id: battle.id } })).roundEndsAt).not.toBeNull();
  });

  it('blocks a user by @username', async () => {
    await sendText(50, '/start');
    await press(ADMIN_TG_ID, 'a:in:block');
    await sendText(ADMIN_TG_ID, '@u50');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { telegramId: 50n } })).isBlocked).toBe(true);
    api.length = 0;
    await sendText(50, '/start');
    expect(texts('sendMessage').at(-1)).toContain('доступ к Photo Battle ограничен');
  });
});
