import { FinalSpotService } from './modules/final-spots/final-spot.service.js';
import { ReferralService } from './modules/referrals/referral.service.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Env } from './config/env.js';
import { getLocale, setDefaultLanguage } from './i18n/index.js';
import type { Logger } from './lib/logger.js';
import { ActivityService } from './modules/activity/activity.service.js';
import { AdminService } from './modules/admins/admin.service.js';
import { BattleService } from './modules/battles/battle.service.js';
import { BroadcastService } from './modules/broadcasts/broadcast.service.js';
import type { BotIdentity, ChannelInfo, JobScheduler, TelegramGateway } from './modules/contracts.js';
import { DuelVoteService } from './modules/duels/duel-vote.service.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { MonobankClient, type BankClient } from './modules/payments/monobank.js';
import { PaymentService } from './modules/payments/payment.service.js';
import { PhotoService } from './modules/photos/photo.service.js';
import { SettingsService } from './modules/settings/settings.service.js';
import { StatsService } from './modules/stats/stats.service.js';
import { UserService } from './modules/users/user.service.js';

export interface ServiceDeps {
  prisma: PrismaClient;
  telegram: TelegramGateway;
  scheduler: JobScheduler;
  channel: ChannelInfo;
  bot: BotIdentity;
  logger: Logger;
  env: Pick<Env, 'DEFAULT_LANGUAGE' | 'TIMEZONE' | 'BROADCAST_RATE_PER_SECOND' | 'CARD_CURRENCY' | 'MAX_TIEBREAKS'> & {
    PAYMENT_PROVIDER_TOKEN?: string | undefined;
    MONOBANK_TOKEN?: string | undefined;
    TRANSFER_TTL_MINUTES?: number;
    TRANSFER_REVIEW_HOURS?: number;
    TRANSFER_REVIEW_AFTER_MINUTES?: number;
    OVERTIME_MINUTES?: number;
  };
  /** Bank statement reader; defaults to Monobank when MONOBANK_TOKEN is set (tests pass a fake). */
  bank?: BankClient | null;
}

export interface Services {
  activity: ActivityService;
  settings: SettingsService;
  admins: AdminService;
  users: UserService;
  notifications: NotificationService;
  battles: BattleService;
  duelVotes: DuelVoteService;
  photos: PhotoService;
  stats: StatsService;
  broadcasts: BroadcastService;
  payments: PaymentService;
  finalSpots: FinalSpotService;
  referrals: ReferralService;
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
  const settings = new SettingsService(prisma, activity);
  const admins = new AdminService(prisma, activity, logger);
  const users = new UserService(prisma, activity);
  const notifications = new NotificationService(telegram, users, admins, env.DEFAULT_LANGUAGE, logger);
  const battles = new BattleService(prisma, settings, activity, notifications, telegram, scheduler, channel, deps.bot, locale, logger, {
    timeZone: env.TIMEZONE,
    maxTiebreaks: env.MAX_TIEBREAKS,
  });
  const finalSpots = new FinalSpotService(prisma, activity, notifications, telegram, logger, settings);
  battles.attachFinalSpots(finalSpots);
  finalSpots.attachBattles(battles);
  const duelVotes = new DuelVoteService(prisma, settings, scheduler, telegram, channel);
  const photos = new PhotoService(prisma, settings, battles, activity, notifications, logger);
  const stats = new StatsService(prisma);
  const broadcasts = new BroadcastService(prisma, telegram, scheduler, activity, notifications, logger, env.BROADCAST_RATE_PER_SECOND);
  const bank = deps.bank !== undefined ? deps.bank : env.MONOBANK_TOKEN ? new MonobankClient(env.MONOBANK_TOKEN) : null;
  const payments = new PaymentService(
    prisma,
    settings,
    activity,
    scheduler,
    telegram,
    logger,
    {
      cardEnabled: !!env.PAYMENT_PROVIDER_TOKEN,
      cardCurrency: env.CARD_CURRENCY,
      transferTtlMinutes: env.TRANSFER_TTL_MINUTES ?? 5,
      manualReviewHours: env.TRANSFER_REVIEW_HOURS ?? 12,
      reviewAfterMinutes: env.TRANSFER_REVIEW_AFTER_MINUTES ?? 5,
      overtimeMinutes: env.OVERTIME_MINUTES ?? 0,
    },
    notifications,
    bank,
  );

  const referrals = new ReferralService(prisma, activity, notifications, deps.bot.username);
  return { activity, settings, admins, users, notifications, battles, duelVotes, photos, stats, broadcasts, payments, finalSpots, referrals };
}
