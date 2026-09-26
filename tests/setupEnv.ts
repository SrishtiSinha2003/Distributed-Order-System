process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/orders_test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.RATE_LIMIT_CAPACITY = '3';
process.env.RATE_LIMIT_REFILL_RATE = '1';
process.env.IDEMPOTENCY_TTL_SECONDS = '60';
process.env.IDEMPOTENCY_LOCK_TTL_SECONDS = '5';
process.env.ORDER_CACHE_TTL_SECONDS = '30';
