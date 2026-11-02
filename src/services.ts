import type { PrismaClient } from './generated/prisma/client.js';
import type { Env } from './config/env.js';
import { getLocale, setDefaultLanguage } from './i18n/index.js';
import type { Logger } from './lib/logger.js';
import { ActivityService } from './modules/activity/activity.service.js';
import { AdminService } from './modules/admins/admin.service.js';
import { BattleService } from './modules/battles/battle.service.js';
import { BroadcastService } from './modules/broadcasts/broadcast.service.js';
import type { BotIdentity, ChannelInfo, JobScheduler, TelegramGateway } from './modules/contracts.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { PaymentService } from './modules/payments/payment.service.js';
import { PhotoService } from './modules/photos/photo.service.js';
import { PublicationService } from './modules/publications/publication.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
import { StatsService } from './modules/stats/stats.service.js';
import { UserService } from './modules/users/user.service.js';
import { VoteService } from './modules/votes/vote.service.js';

export interface ServiceDeps {
  prisma: PrismaClient;
  telegram: TelegramGateway;
  scheduler: JobScheduler;
  channel: ChannelInfo;
  bot: BotIdentity;
  logger: Logger;
  env: Pick<Env, 'DEFAULT_LANGUAGE' | 'TIMEZONE' | 'PUBLISH_MAX_ATTEMPTS' | 'BROADCAST_RATE_PER_SECOND' | 'CARD_CURRENCY'> & {
    PAYMENT_PROVIDER_TOKEN?: string | undefined;
  };
}

export interface Services {
  activity: ActivityService;
  settings: SettingsService;
  admins: AdminService;
  users: UserService;
  notifications: NotificationService;
  battles: BattleService;
  photos: PhotoService;
  publications: PublicationService;
  votes: VoteService;
  stats: StatsService;
  broadcasts: BroadcastService;
  payments: PaymentService;
}

/**
 * Composition root. Channel-facing texts use the default language
 * (the channel audience is shared); user-facing texts use the user's locale.
 */
export function createServices(deps: ServiceDeps): Services {
  const { prisma, telegram, scheduler, channel, logger, env } = deps;
  setDefaultLanguage(env.DEFAULT_LANGUAGE);
  const locale = getLocale(env.DEFAULT_LANGUAGE);

  const activity = new ActivityService(prisma, logger);
  const settings = new SettingsService(prisma, activity, scheduler);
  const admins = new AdminService(prisma, activity, logger);
  const users = new UserService(prisma, activity);
  const notifications = new NotificationService(telegram, users, admins, env.DEFAULT_LANGUAGE, logger);
  const battles = new BattleService(prisma, settings, activity, notifications, telegram, channel, deps.bot, locale, env.TIMEZONE, logger);
  const photos = new PhotoService(prisma, settings, battles, activity, notifications, telegram, scheduler, channel, logger);
  const publications = new PublicationService(prisma, telegram, scheduler, settings, activity, notifications, channel, locale, logger, {
    maxAttempts: env.PUBLISH_MAX_ATTEMPTS,
  });
  const votes = new VoteService(prisma, settings, scheduler, telegram, channel, locale);
  const stats = new StatsService(prisma);
  const broadcasts = new BroadcastService(prisma, telegram, scheduler, activity, notifications, logger, env.BROADCAST_RATE_PER_SECOND);

  const payments = new PaymentService(prisma, settings, activity, scheduler, telegram, logger, {
    cardEnabled: !!env.PAYMENT_PROVIDER_TOKEN,
    cardCurrency: env.CARD_CURRENCY,
  });

  return { activity, settings, admins, users, notifications, battles, photos, publications, votes, stats, broadcasts, payments };
}
