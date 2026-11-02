import type { Redis } from 'ioredis';
import { Telegraf } from 'telegraf';
import { session } from 'telegraf/session';
import type { AppContextDeps, BotContext, SessionData } from './context.js';
import { registerAdminHandlers } from './handlers/admin/index.js';
import { registerCommonHandlers, registerFallback } from './handlers/common.js';
import { registerMyPhotosHandlers } from './handlers/my-photos.js';
import { registerProfileHandlers } from './handlers/profile.js';
import { registerSubmissionHandlers } from './handlers/submission.js';
import { registerVoteHandlers } from './handlers/votes.js';
import { chatFilter } from './middlewares/chat-filter.js';
import { errorBoundary } from './middlewares/error-boundary.js';
import { rateLimit } from './middlewares/rate-limit.js';
import { blockedGuard, loadUser } from './middlewares/user.js';
import { RedisSessionStore } from './session-store.js';
import { getLocale } from '../i18n/index.js';

/** Builds the bot: middleware order matters (filter → limits → user → guards → session → handlers). */
export function createBot(bot: Telegraf<BotContext>, deps: AppContextDeps, redis: Redis): Telegraf<BotContext> {
  bot.use(async (ctx, next) => {
    ctx.deps = deps;
    ctx.isAdmin = false;
    ctx.locale = getLocale(deps.env.DEFAULT_LANGUAGE);
    return next();
  });
  bot.use(errorBoundary);
  bot.use(chatFilter);
  bot.use(rateLimit(redis, deps.env.RATE_LIMIT_PER_MINUTE));
  bot.use(loadUser);
  bot.use(blockedGuard);
  bot.use(
    session<SessionData, BotContext>({
      store: new RedisSessionStore(redis),
      // Sessions exist only in private chats; channel vote callbacks do not need one.
      getSessionKey: (ctx) => (ctx.chat?.type === 'private' && ctx.from ? `${ctx.from.id}` : undefined),
      defaultSession: () => ({}),
    }),
  );

  registerVoteHandlers(bot);
  registerAdminHandlers(bot);
  registerCommonHandlers(bot);
  registerSubmissionHandlers(bot);
  registerMyPhotosHandlers(bot);
  registerProfileHandlers(bot);
  registerFallback(bot);

  bot.catch((error, ctx) => {
    deps.logger.error({ err: error, updateId: ctx.update.update_id }, 'Unhandled bot error');
  });
  return bot;
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'myphotos', description: 'Мои фотографии' },
  { command: 'stats', description: 'Моя статистика' },
  { command: 'rating', description: 'Рейтинг участников' },
  { command: 'battle', description: 'Текущий батл' },
  { command: 'rules', description: 'Правила' },
  { command: 'help', description: 'Помощь' },
  { command: 'cancel', description: 'Отменить действие' },
  { command: 'deletedata', description: 'Удалить мои фотографии' },
];
