import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Logger } from '../lib/logger.js';

type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Health endpoint for Docker/Railway and, in webhook mode, the Telegram webhook. */
export function startHttpServer(options: {
  port: number;
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
  webhook?: { path: string; handler: WebhookHandler };
}): Server {
  const { prisma, redis, logger, webhook } = options;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      const checks = { database: false, redis: false };
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = true;
      } catch (error) {
        logger.warn({ err: error }, 'Health check: database unavailable');
      }
      try {
        checks.redis = (await redis.ping()) === 'PONG';
      } catch (error) {
        logger.warn({ err: error }, 'Health check: redis unavailable');
      }
      const healthy = checks.database && checks.redis;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', ...checks }));
      return;
    }
    if (webhook && req.method === 'POST' && url.pathname === webhook.path) {
      await webhook.handler(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(options.port, () => logger.info({ port: options.port }, 'HTTP server listening'));
  return server;
}
