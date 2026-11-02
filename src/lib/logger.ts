import { pino, type Logger } from 'pino';

const TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

/** Masks Telegram bot tokens that may appear inside URLs or error messages. */
export function maskSecrets(value: string): string {
  return value.replace(TOKEN_PATTERN, '<bot-token>');
}

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: {
      paths: ['token', '*.token', 'BOT_TOKEN', '*.BOT_TOKEN', 'password', '*.password', 'headers.authorization'],
      censor: '<redacted>',
    },
    serializers: {
      err: (err: unknown) => {
        const serialized = pino.stdSerializers.err(err as Error);
        if (serialized.message) serialized.message = maskSecrets(serialized.message);
        if (serialized.stack) serialized.stack = maskSecrets(serialized.stack);
        return serialized;
      },
    },
    hooks: {
      logMethod(args, method) {
        const masked = args.map((arg) => (typeof arg === 'string' ? maskSecrets(arg) : arg)) as typeof args;
        method.apply(this, masked);
      },
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
}

export type { Logger };
