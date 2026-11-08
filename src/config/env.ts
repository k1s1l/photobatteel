import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const telegramIdList = z
  .string()
  .default('')
  .transform((raw, ctx) => {
    const ids = raw
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const parsed: number[] = [];
    for (const id of ids) {
      if (!/^\d{1,15}$/.test(id)) {
        ctx.addIssue({ code: 'custom', message: `Invalid Telegram user id in ADMIN_IDS: "${id}"` });
        return z.NEVER;
      }
      parsed.push(Number(id));
    }
    return parsed;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'BOT_TOKEN has an invalid format (expected 123456:ABC...)'),
    CHANNEL_ID: z
      .string()
      .regex(/^(-100\d{5,}|@[A-Za-z0-9_]{5,})$/, 'CHANNEL_ID must be -100XXXXXXXXXX or @channel_username'),
    ADMIN_IDS: telegramIdList,

    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    /** Optional self-hosted Bot API server (https://github.com/tdlib/telegram-bot-api). */
    TELEGRAM_API_ROOT: z.string().url().optional(),
    BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
    WEBHOOK_DOMAIN: z.string().url().optional(),
    WEBHOOK_PATH: z.string().startsWith('/').default('/telegram/webhook'),
    WEBHOOK_SECRET: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,256}$/, 'WEBHOOK_SECRET must be 16-256 chars of A-Z, a-z, 0-9, _ or -')
      .optional(),
    PORT: z.coerce.number().int().positive().default(8080),
    APP_ROLE: z.enum(['all', 'bot', 'worker']).default('all'),

    /** Payment provider token from @BotFather → Payments. Enables card payments; Stars work without it. */
    PAYMENT_PROVIDER_TOKEN: z.string().min(10).optional(),
    CARD_CURRENCY: z.string().regex(/^[A-Z]{3}$/, 'CARD_CURRENCY must be a 3-letter ISO code').default('UAH'),
    /** Monobank personal API token (api.monobank.ua): transfers to your card/jar are verified automatically. */
    MONOBANK_TOKEN: z.string().min(20).optional(),
    /** Minutes a buyer has to make a transfer before the order expires. */
    TRANSFER_TTL_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(30),
    /** Minutes the bank check may take before a claimed transfer is sent to the admins. */
    TRANSFER_REVIEW_AFTER_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(5),
    /** Paid votes in the last N minutes of a pair extend its voting to N minutes from that moment (0 = off). */
    OVERTIME_MINUTES: z.coerce.number().int().min(0).max(60).default(5),
    /** Hours a claimed transfer waits for an admin before it is cancelled. */
    TRANSFER_REVIEW_HOURS: z.coerce.number().int().min(1).max(7 * 24).default(12),
    DEFAULT_LANGUAGE: z.enum(['uk', 'ru']).default('uk'),
    TIMEZONE: z.string().default('Europe/Kyiv'),

    MAX_PHOTO_SIZE_MB: z.coerce.number().positive().max(20).default(10),
    MIN_PHOTO_DIMENSION: z.coerce.number().int().positive().default(320),
    MAX_PHOTO_DIMENSION: z.coerce.number().int().positive().default(10000),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
    /** Attempts to post a duel on temporary Telegram errors, and the first retry delay. */
    PUBLISH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    PUBLISH_RETRY_BASE_MS: z.coerce.number().int().min(1000).default(30_000),
    /** Pause between duel posts — Telegram allows about 20 posts per minute in one channel. */
    DUEL_POST_INTERVAL_SECONDS: z.coerce.number().int().min(3).max(600).default(5),
    /** Default voting time of a tiebreak repost (admins can change it per battle). */
    TIEBREAK_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
    /** Tiebreak reposts before the earlier entry wins a tie. */
    MAX_TIEBREAKS: z.coerce.number().int().min(0).max(10).default(3),
    MAX_VIDEO_DURATION_SECONDS: z.coerce.number().int().min(1).max(3600).default(180),
    DRAFT_TTL_HOURS: z.coerce.number().int().positive().default(24),
    BROADCAST_RATE_PER_SECOND: z.coerce.number().int().min(1).max(30).default(20),
    RUN_STARTUP_CHECKS: booleanString.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.BOT_MODE === 'webhook') {
      if (!env.WEBHOOK_DOMAIN) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_DOMAIN'], message: 'Required in webhook mode' });
      if (!env.WEBHOOK_SECRET) ctx.addIssue({ code: 'custom', path: ['WEBHOOK_SECRET'], message: 'Required in webhook mode' });
    }
    if (env.MIN_PHOTO_DIMENSION > env.MAX_PHOTO_DIMENSION) {
      ctx.addIssue({ code: 'custom', path: ['MIN_PHOTO_DIMENSION'], message: 'Must not exceed MAX_PHOTO_DIMENSION' });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Optional integrations. A wrong value here must not take the whole bot down:
 * the integration is switched off and a warning is printed instead.
 */
const SOFT_OPTIONAL_KEYS = ['PAYMENT_PROVIDER_TOKEN', 'MONOBANK_TOKEN', 'TELEGRAM_API_ROOT'] as const;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const input: NodeJS.ProcessEnv = { ...source };
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim() === '') delete input[key];
  }
  for (const key of SOFT_OPTIONAL_KEYS) {
    if (input[key] === undefined) continue;
    const check = envSchema.shape[key].safeParse(input[key]);
    if (!check.success) {
      delete input[key];
      // Never print the value itself: it may be a secret.
      console.warn(`Warning: ${key} has an invalid value and is ignored (${check.error.issues[0]?.message ?? 'invalid'}).`);
    }
  }
  const result = envSchema.safeParse(input);
  if (!result.success) {
    // Never print values: they may contain secrets. Only names and reasons.
    const details = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}
