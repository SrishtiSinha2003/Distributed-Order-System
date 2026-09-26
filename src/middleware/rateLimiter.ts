import { Request, Response, NextFunction } from 'express';
import type { Redis as RedisClient } from 'ioredis';
import { config } from '../config';

/**
 * Atomic token-bucket rate limiter.
 *
 * Why a Lua script: a naive "GET tokens, check, SET tokens" from Node is a
 * classic read-modify-write race under concurrency - two requests can both
 * read 1 token remaining and both be allowed through. Running the whole
 * check-and-decrement as a single Redis Lua script makes it atomic, so the
 * limiter is correct even with many concurrent requests hitting the same key.
 *
 * Algorithm: each client key stores {tokens, last_refill_ts}. On each
 * request we lazily refill tokens based on elapsed time
 * (elapsed * refillRatePerSecond), cap at capacity, then try to spend 1
 * token. This is a standard token-bucket, so bursts up to `capacity` are
 * allowed but sustained throughput is capped at refillRatePerSecond.
 */
const TOKEN_BUCKET_SCRIPT = `
local key            = KEYS[1]
local capacity       = tonumber(ARGV[1])
local refill_rate    = tonumber(ARGV[2]) -- tokens per second
local now            = tonumber(ARGV[3]) -- ms
local ttl_seconds    = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local last_ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  last_ts = now
end

local elapsed_seconds = math.max(0, (now - last_ts) / 1000)
local refilled = math.min(capacity, tokens + (elapsed_seconds * refill_rate))

local allowed = 0
if refilled >= 1 then
  allowed = 1
  refilled = refilled - 1
end

redis.call('HMSET', key, 'tokens', refilled, 'ts', now)
redis.call('EXPIRE', key, ttl_seconds)

return { allowed, math.floor(refilled) }
`;

export interface RateLimiterOptions {
  redis: RedisClient;
  capacity?: number;
  refillRatePerSecond?: number;
  windowSeconds?: number;
  keyFn?: (req: Request) => string;
}

export function createRateLimiter(opts: RateLimiterOptions) {
  const capacity = opts.capacity ?? config.rateLimit.capacity;
  const refillRatePerSecond = opts.refillRatePerSecond ?? config.rateLimit.refillRatePerSecond;
  const windowSeconds = opts.windowSeconds ?? config.rateLimit.windowSeconds;
  const keyFn = opts.keyFn ?? ((req: Request) => `ratelimit:${req.ip}`);

  return async function rateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = keyFn(req);
      const now = Date.now();

      const result = (await opts.redis.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        key,
        capacity,
        refillRatePerSecond,
        now,
        windowSeconds
      )) as [number, number];

      const [allowed, remaining] = result;

      res.setHeader('X-RateLimit-Limit', String(capacity));
      res.setHeader('X-RateLimit-Remaining', String(remaining));

      if (!allowed) {
        res.setHeader('Retry-After', String(Math.ceil(1 / refillRatePerSecond)));
        res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please slow down.' });
        return;
      }

      next();
    } catch (err) {
      // Fail open: if Redis is down we don't want the rate limiter to take
      // the whole API down with it. We log loudly so it's visible in
      // monitoring instead.
      // eslint-disable-next-line no-console
      console.error('[rateLimiter] Redis error, failing open:', (err as Error).message);
      next();
    }
  };
}
