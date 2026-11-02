import { Redis } from 'ioredis';
import { Telegraf, Telegram } from 'telegraf';
import type { Update } from 'telegraf/types';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot } from '../../src/bot/bot.js';
import type { BotContext } from '../../src/bot/context.js';
import { parseEnv } from '../../src/config/env.js';
import { LockService } from '../../src/lib/locks.js';
import { ADMIN_TG_ID, CHANNEL, createTestContext, type TestContext } from '../helpers/context.js';
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
    if (method.startsWith('send') || method === 'copyMessage') return { message_id: id, date: 0, chat: { id: payload.chat_id } };
    return true;
  }) as typeof Telegram.prototype.callApi);
  createBot(bot, { services: ctx.services, locks: new LockService(redis), gateway: ctx.telegram, channel: CHANNEL, logger: silentLogger, env }, redis);
});

function from(id: number, username = `u${id}`, languageCode?: string) {
  return { id, is_bot: false, first_name: `Name${id}`, username, ...(languageCode ? { language_code: languageCode } : {}) };
}

async function sendText(userId: number, text: string, username?: string) {
  const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId++, date: 0, chat: { id: userId, type: 'private', first_name: 'N' }, from: from(userId, username), text, ...(entities ? { entities } : {}) },
  } as Update);
}

async function sendPhoto(userId: number, fileId: string, fileUniqueId: string) {
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: messageId++,
      date: 0,
      chat: { id: userId, type: 'private', first_name: 'N' },
      from: from(userId),
      photo: [{ file_id: fileId, file_unique_id: fileUniqueId, width: 800, height: 600, file_size: 50_000 }],
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
      message: { message_id: 1, date: 0, chat: chat.type === 'private' ? { id: chat.id, type: 'private', first_name: 'N' } : { id: chat.id, type: 'channel', title: 'C' }, text: 'x' },
    },
  } as Update);
}

const texts = (method: string) => api.filter((c) => c.method === method).map((c) => String(c.payload.text ?? c.payload.caption ?? ''));
const answers = () => api.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.payload.text ?? ''));

describe('bot: registration and menu', () => {
  it('registers the user on /start and shows the welcome message with the menu', async () => {
    await sendText(10, '/start');
    expect(await ctx.prisma.user.count({ where: { telegramId: 10n } })).toBe(1);
    const reply = api.find((c) => c.method === 'sendMessage')!;
    expect(String(reply.payload.text)).toContain('Добро пожаловать в Photo Battle! 📸');
    const keyboard = JSON.stringify(reply.payload.reply_markup);
    for (const label of ['📸 Отправить фотографию', '⭐ Купить голоса', '⚔️ Текущий батл', 'ℹ️ Правила', '❓ Помощь']) expect(keyboard).toContain(label);
    for (const label of ['🏆 Мои фотографии', '📊 Моя статистика', '🥇 Рейтинг', '🌐 Язык']) expect(keyboard).not.toContain(label);
    expect(keyboard).not.toContain('Админ-панель');
  });

  it('shows the admin button to admins only', async () => {
    await sendText(ADMIN_TG_ID, '/start');
    expect(JSON.stringify(api.find((c) => c.method === 'sendMessage')?.payload.reply_markup)).toContain('🛠 Админ-панель');
  });
});

describe('bot: photo submission flow', () => {
  it('goes through consent → photo → preview → confirm, and ignores a second confirm', async () => {
    ctx.telegram.files.set('tg-file-1', await makeJpeg());
    await sendText(20, '📸 Отправить фотографию');
    expect(texts('sendMessage').at(-1)).toContain('Согласие на публикацию');
    await press(20, 'consent');
    expect(texts('sendMessage').at(-1)).toContain('Отправь одну фотографию');

    await sendPhoto(20, 'tg-file-1', 'tg-unique-1');
    const preview = api.filter((c) => c.method === 'sendPhoto').at(-1)!;
    expect(String(preview.payload.caption)).toContain('Предпросмотр');
    const photo = await ctx.prisma.photo.findFirstOrThrow();
    expect(photo.status).toBe('DRAFT');
    expect(JSON.stringify(preview.payload.reply_markup)).toContain(`ph:ok:${photo.id}`);

    await press(20, `ph:ok:${photo.id}`);
    expect(texts('sendMessage').some((t) => t.includes('✅ Твоя фотография успешно принята!'))).toBe(true);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('QUEUED');

    await press(20, `ph:ok:${photo.id}`);
    expect(answers().at(-1)).toBe('Это действие уже выполнено.');
    expect(await ctx.prisma.publicationQueue.count()).toBe(1);
  });

  it('rejects non-images and corrupted files with a clear message', async () => {
    const jpeg = await makeUniqueJpeg(1);
    ctx.telegram.files.set('broken', jpeg.subarray(0, 200));
    await ctx.services.users.giveConsent((await ctx.services.users.upsertFromTelegram({ id: 30, first_name: 'C' })).user.id);
    await sendText(30, '📸 Отправить фотографию');
    await sendText(30, 'hello');
    expect(texts('sendMessage').at(-1)).toContain('Это не изображение');
    await sendPhoto(30, 'broken', 'broken-u');
    expect(texts('sendMessage').at(-1)).toContain('Не удалось прочитать изображение');
    expect(await ctx.prisma.photo.count()).toBe(0);
  });

  it('lets the user cancel before confirmation', async () => {
    ctx.telegram.files.set('f', await makeUniqueJpeg(2));
    await ctx.services.users.giveConsent((await ctx.services.users.upsertFromTelegram({ id: 31, first_name: 'C' })).user.id);
    await sendPhoto(31, 'f', 'fu');
    const photo = await ctx.prisma.photo.findFirstOrThrow();
    await press(31, `ph:no:${photo.id}`);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).status).toBe('CANCELLED');
    await press(31, `ph:ok:${photo.id}`);
    expect(await ctx.prisma.publicationQueue.count()).toBe(0);
  });
});

describe('bot: stale previews', () => {
  it('explains that an older preview is no longer valid after a new photo is sent', async () => {
    ctx.telegram.files.set('a', await makeUniqueJpeg(11));
    ctx.telegram.files.set('b', await makeUniqueJpeg(12));
    await ctx.services.users.giveConsent((await ctx.services.users.upsertFromTelegram({ id: 32, first_name: 'S' })).user.id);
    await sendPhoto(32, 'a', 'au');
    await sendPhoto(32, 'b', 'bu');
    const [first, second] = await ctx.prisma.photo.findMany({ orderBy: { id: 'asc' } });
    await press(32, `ph:ok:${first!.id}`);
    expect(answers().at(-1)).toContain('предпросмотр больше не действителен');
    await press(32, `ph:ok:${second!.id}`);
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe('QUEUED');
  });
});

describe('bot: admin access control', () => {
  it('denies admin buttons and commands to regular users', async () => {
    await press(40, 'a:stats');
    expect(answers().at(-1)).toContain('нет доступа');
    await press(40, 'a:pause');
    expect((await ctx.services.settings.get()).publishingPaused).toBe(false);
    await sendText(40, '/admin');
    expect(texts('sendMessage').at(-1)).toContain('нет доступа');
    expect(await ctx.prisma.activityLog.count({ where: { action: 'ADMIN_ACCESS_DENIED' } })).toBe(3);
  });

  it('lets an admin open the panel, pause publishing and block a user by @username', async () => {
    await sendText(50, '/start', 'victim');
    await sendText(ADMIN_TG_ID, '/admin');
    expect(texts('sendMessage').at(-1)).toContain('Админ-панель Photo Battle');

    await press(ADMIN_TG_ID, 'a:pause');
    ctx.services.settings.invalidate();
    expect((await ctx.services.settings.get()).publishingPaused).toBe(true);

    await press(ADMIN_TG_ID, 'a:in:block');
    await sendText(ADMIN_TG_ID, '@victim');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { telegramId: 50n } })).isBlocked).toBe(true);

    api.length = 0;
    await sendText(50, '/start', 'victim');
    expect(texts('sendMessage').at(-1)).toContain('доступ к Photo Battle ограничен');
  });
});

describe('bot: channel voting', () => {
  it('counts a vote pressed under a channel post', async () => {
    const owner = (await ctx.services.users.upsertFromTelegram({ id: 60, first_name: 'Owner' })).user;
    await ctx.services.users.giveConsent(owner.id);
    ctx.telegram.files.set('v', await makeUniqueJpeg(3));
    await sendPhoto(60, 'v', 'vu');
    const photo = await ctx.prisma.photo.findFirstOrThrow();
    await press(60, `ph:ok:${photo.id}`);
    const item = await ctx.services.publications.claimNext();
    await ctx.services.publications.processItem(item!.id);

    await press(61, `v:${photo.id}`, { id: CHANNEL.id, type: 'channel' });
    expect(answers().at(-1)).toContain('Голос учтён');
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).votesCount).toBe(1);
    await press(60, `v:${photo.id}`, { id: CHANNEL.id, type: 'channel' });
    expect(answers().at(-1)).toContain('Нельзя голосовать за свою');
  });
});

describe('bot: Ukrainian language', () => {
  it('greets Ukrainian Telegram users in Ukrainian and lets them switch to Russian', async () => {
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: messageId++, date: 0, chat: { id: 90, type: 'private', first_name: 'N' }, from: from(90, 'olena', 'uk'), text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] },
    } as Update);
    const welcome = api.find((c) => c.method === 'sendMessage')!;
    expect(String(welcome.payload.text)).toContain('Ласкаво просимо до Photo Battle! 📸');
    expect(JSON.stringify(welcome.payload.reply_markup)).toContain('📸 Надіслати фотографію');

    await press(90, 'lang:ru');
    expect(texts('sendMessage').at(-1)).toContain('Язык интерфейса: русский');
    await sendText(90, '📊 Моя статистика');
    expect(texts('sendMessage').at(-1)).toContain('Моя статистика');
    await sendText(90, '🌐 Язык');
    await press(90, 'lang:uk');
    await sendText(90, '📊 Моя статистика');
    expect(texts('sendMessage').at(-1)).toContain('Отримано голосів');
  });
});

describe('bot: paid votes', () => {
  async function publishedPhotoOf(ownerTgId: number) {
    const owner = (await ctx.services.users.upsertFromTelegram({ id: ownerTgId, first_name: 'Owner' })).user;
    await ctx.services.users.giveConsent(owner.id);
    ctx.telegram.files.set(`p${ownerTgId}`, await makeUniqueJpeg(ownerTgId));
    await sendPhoto(ownerTgId, `p${ownerTgId}`, `pu${ownerTgId}`);
    const photo = await ctx.prisma.photo.findFirstOrThrow({ where: { userId: owner.id } });
    await press(ownerTgId, `ph:ok:${photo.id}`);
    await ctx.services.publications.processItem((await ctx.services.publications.claimNext())!.id);
    return photo;
  }

  it('sells votes for Stars and spends them with the channel button', async () => {
    await ctx.services.settings.update({ paidVotesEnabled: true }, null);
    const photo = await publishedPhotoOf(70);

    await sendText(71, '⭐ Купить голоса');
    const menu = api.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(menu.payload.text)).toContain('Дополнительные голоса');
    const [pack] = await ctx.services.payments.listPackages(true);
    expect(JSON.stringify(menu.payload.reply_markup)).toContain(`pay:s:${pack!.id}:0`);
    expect(JSON.stringify(menu.payload.reply_markup)).toContain(`pay:c:${pack!.id}:0`);

    await press(71, `pay:s:${pack!.id}:0`);
    const invoice = api.find((c) => c.method === 'sendInvoice')!;
    expect(invoice.payload).toMatchObject({ currency: 'XTR', provider_token: '', prices: [{ amount: pack!.priceStars }] });

    await bot.handleUpdate({
      update_id: updateId++,
      pre_checkout_query: { id: 'pcq1', from: from(71), currency: 'XTR', total_amount: pack!.priceStars, invoice_payload: String(invoice.payload.payload) },
    } as Update);
    expect(api.find((c) => c.method === 'answerPreCheckoutQuery')?.payload).toMatchObject({ ok: true });

    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId++,
        date: 0,
        chat: { id: 71, type: 'private', first_name: 'N' },
        from: from(71),
        successful_payment: {
          currency: 'XTR',
          total_amount: pack!.priceStars,
          invoice_payload: String(invoice.payload.payload),
          telegram_payment_charge_id: 'stars-charge-1',
          provider_payment_charge_id: '',
        },
      },
    } as Update);
    expect(texts('sendMessage').at(-1)).toContain('На баланс зачислено 5');

    await press(71, `b:${photo.id}`, { id: CHANNEL.id, type: 'channel' });
    expect(answers().at(-1)).toContain('Осталось на балансе: 4');
    expect((await ctx.prisma.photo.findUniqueOrThrow({ where: { id: photo.id } })).votesCount).toBe(1);
  });

  it('opens the purchase in the bot when the balance is empty', async () => {
    await ctx.services.settings.update({ paidVotesEnabled: true }, null);
    const photo = await publishedPhotoOf(72);
    await press(73, `b:${photo.id}`, { id: CHANNEL.id, type: 'channel' });
    const reply = api.filter((c) => c.method === 'answerCallbackQuery').at(-1)!;
    expect(String(reply.payload.url)).toBe(`https://t.me/photobattle_bot?start=boost_${photo.id}`);

    await sendText(73, `/start boost_${photo.id}`);
    expect(texts('sendMessage').at(-1)).toContain(`Голоса для фото #000${photo.id}`);
  });

  it('rejects a stale pre-checkout query', async () => {
    await bot.handleUpdate({
      update_id: updateId++,
      pre_checkout_query: { id: 'pcq2', from: from(74), currency: 'XTR', total_amount: 25, invoice_payload: 'order:424242' },
    } as Update);
    expect(api.find((c) => c.method === 'answerPreCheckoutQuery')?.payload).toMatchObject({ ok: false });
  });
});
