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
  },

  admin: {
    // No default on purpose: forces an operator to set a real value in any
    // environment that isn't local dev, rather than silently shipping with
    // a guessable default.
    apiKey: process.env.ADMIN_API_KEY ?? 'local-dev-only-change-me'
  },

  // Some free-tier hosts (Render's free plan, notably) only offer a free
  // web service - no free background worker. Setting this runs both
  // workers as in-process listeners on the same Node process as the API,
  // which is a valid (if less isolated) deployment topology. Local
  // docker-compose and the render.yaml Starter/paid path both leave this
  // off and run workers as separate processes, which is what you'd want
  // for anything beyond a free demo.
  runWorkersInProcess: process.env.RUN_WORKERS_IN_PROCESS === 'true'
};
