import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num('PORT', 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/orders',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  rateLimit: {
    capacity: num('RATE_LIMIT_CAPACITY', 20),
    refillRatePerSecond: num('RATE_LIMIT_REFILL_RATE', 5),
    windowSeconds: num('RATE_LIMIT_WINDOW_SECONDS', 60)
  },

  idempotency: {
    ttlSeconds: num('IDEMPOTENCY_TTL_SECONDS', 86400),
    lockTtlSeconds: num('IDEMPOTENCY_LOCK_TTL_SECONDS', 30)
  },

  cache: {
    orderTtlSeconds: num('ORDER_CACHE_TTL_SECONDS', 30)
  },

  queue: {
    orderQueueName: process.env.ORDER_QUEUE_NAME ?? 'process-order',
    notificationQueueName: process.env.NOTIFICATION_QUEUE_NAME ?? 'send-confirmation',
    deadLetterQueueName: process.env.DEAD_LETTER_QUEUE_NAME ?? 'order-dead-letter',
    maxAttempts: num('MAX_JOB_ATTEMPTS', 5),
    backoffBaseMs: num('BACKOFF_BASE_MS', 1000)
  }
};
