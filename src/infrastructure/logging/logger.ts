import { pino, type Logger } from 'pino';
import type { Env } from '../../config/env.js';

/**
 * Structured logger. JSON in production so a log shipper can parse it; the
 * human-readable transport is only loaded in development, where the extra
 * dependency cost does not matter.
 */
export function createLogger(env: Env): Logger {
  const redact = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-payment"]',
    'env.AI_API_KEY',
    'env.DATABASE_URL',
  ];

  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'test') {
    return pino({ level: env.LOG_LEVEL, redact });
  }

  return pino({
    level: env.LOG_LEVEL,
    redact,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  });
}
