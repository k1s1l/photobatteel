import type { Server } from 'node:http';
import type { Worker } from 'bullmq';
import { Telegraf } from 'telegraf';
import { parseEnv } from './config/env.js';
import { createBot, registerCommands } from './bot/bot.js';
import type { BotContext } from './bot/context.js';
import { TelegrafGateway } from './bot/telegram-gateway.js';
import { startHttpServer } from './bootstrap/http-server.js';
import { initializeDatabase } from './bootstrap/initialize.js';
import { resolveChannel } from './bootstrap/startup-checks.js';
import { LockService } from './lib/locks.js';
import { createLogger, maskSecrets } from './lib/logger.js';
import { createPrisma } from './lib/prisma.js';
import { createRedis } from './lib/redis.js';
import { AppQueues } from './queue/queues.js';
import { startWorkers } from './queue/workers.js';
import { createServices } from './services.js';

const QUEUE_PREFIX = 'photobattle';

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  logger.info({ mode: env.BOT_MODE, role: env.APP_ROLE }, 'Starting Photo Battle Bot');

  const prisma = createPrisma(env.DATABASE_URL);
  await prisma.$connect();
  const redis = createRedis(env.REDIS_URL);
  await redis.ping();

  const bot = new Telegraf<BotContext>(env.BOT_TOKEN, {
    handlerTimeout: 120_000,
    ...(env.TELEGRAM_API_ROOT ? { telegram: { apiRoot: env.TELEGRAM_API_ROOT } } : {}),
  });
  const me = await bot.telegram.getMe().catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    if (code === 401 || code === 404) throw new Error('Telegram rejected BOT_TOKEN (401 Unauthorized). Check the token from @BotFather.');
    throw error;
  });
  logger.info({ username: me.username }, 'Authorized in Telegram');

  const channel = env.RUN_STARTUP_CHECKS
    ? await resolveChannel(bot.telegram, env.CHANNEL_ID, me.id, logger, true)
    : { id: Number(env.CHANNEL_ID) };
  if (!Number.isSafeInteger(channel.id)) throw new Error('CHANNEL_ID must be numeric when RUN_STARTUP_CHECKS=false');

  const gateway = new TelegrafGateway(bot.telegram);
  const queues = new AppQueues({ redisUrl: env.REDIS_URL, prefix: QUEUE_PREFIX, publishMaxAttempts: env.PUBLISH_MAX_ATTEMPTS, timeZone: env.TIMEZONE });
  const services = createServices({ prisma, telegram: gateway, scheduler: queues, channel, bot: { username: me.username }, logger, env });

  await initializeDatabase(services, env.ADMIN_IDS);
  await queues.registerSchedules();

  let workers: Worker[] = [];
  if (env.APP_ROLE !== 'bot') {
    workers = startWorkers(
      services,
      { redisUrl: env.REDIS_URL, prefix: QUEUE_PREFIX, retryBaseMs: env.PUBLISH_RETRY_BASE_MS, draftTtlHours: env.DRAFT_TTL_HOURS },
      logger,
    );
    logger.info('Background workers started');
  }

  let server: Server | undefined;
  let polling = false;
  if (env.APP_ROLE !== 'worker') {
    createBot(bot, { services, locks: new LockService(redis), gateway, channel, logger, env }, redis);
    await registerCommands(bot);
    const allowedUpdates = ['message', 'callback_query', 'pre_checkout_query'] as const;

    if (env.BOT_MODE === 'webhook') {
      const handler = await bot.createWebhook({
        domain: env.WEBHOOK_DOMAIN as string,
        path: env.WEBHOOK_PATH,
        secret_token: env.WEBHOOK_SECRET as string,
        allowed_updates: [...allowedUpdates],
      });
      server = startHttpServer({ port: env.PORT, prisma, redis, logger, webhook: { path: env.WEBHOOK_PATH, handler } });
      logger.info({ path: env.WEBHOOK_PATH }, 'Webhook registered');
    } else {
      server = startHttpServer({ port: env.PORT, prisma, redis, logger });
      polling = true;
      void bot.launch({ allowedUpdates: [...allowedUpdates], dropPendingUpdates: false }, () => logger.info('Long polling started')).catch(
        (error: unknown) => {
          logger.fatal({ err: error }, 'Polling stopped with an error');
          process.exit(1);
        },
      );
    }
  } else {
    server = startHttpServer({ port: env.PORT, prisma, redis, logger });
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => process.exit(1), 25_000);
    try {
      if (polling) bot.stop(signal);
      await Promise.all(workers.map((worker) => worker.close()));
      await queues.close();
      server?.close();
      await prisma.$disconnect();
      redis.disconnect();
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
}

main().catch((error: unknown) => {
  const expected = error instanceof Error && /^(Invalid environment|Telegram rejected|Cannot access channel|CHANNEL_ID|Channel permission)/.test(error.message);
  const message = error instanceof Error ? (expected ? error.message : (error.stack ?? error.message)) : String(error);
  console.error(`Fatal startup error:\n${maskSecrets(message)}`);
  process.exit(1);
});
