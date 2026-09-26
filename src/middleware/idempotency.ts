import { Request, Response, NextFunction } from 'express';
import type { Redis as RedisClient } from 'ioredis';
import crypto from 'crypto';
import { config } from '../config';

/**
 * Idempotency-Key middleware.
 *
 * Clients that retry a POST after a timeout (very common with at-least-once
 * networking) should be able to safely resend the exact same request without
 * creating a duplicate order. Semantics implemented here:
 *
 *  1. No `Idempotency-Key` header -> behaves like a normal, non-idempotent
 *     request (pass through).
 *  2. First time a key is seen -> acquire a short-lived Redis lock (SET NX),
 *     run the handler, then persist the handler's actual response under
 *     that key for `ttlSeconds`.
 *  3. Same key + identical request body seen again while the first request
 *     is still in flight -> 409, the caller should retry later rather than
 *     assume failure.
 *  4. Same key + identical request body seen again after completion -> the
 *     original response is replayed byte-for-byte (same status, same body),
 *     so retries are provably safe.
 *  5. Same key reused with a *different* request body -> 422, because
 *     silently returning the old response would hide a client bug.
 */

interface IdempotencyOptions {
  redis: RedisClient;
  ttlSeconds?: number;
  lockTtlSeconds?: number;
}

interface StoredRecord {
  status: 'in_progress' | 'completed';
  requestHash: string;
  responseStatus?: number;
  responseBody?: unknown;
}

function hashRequest(req: Request): string {
  const payload = JSON.stringify({ method: req.method, path: req.path, body: req.body ?? {} });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function createIdempotencyMiddleware(opts: IdempotencyOptions) {
  const ttlSeconds = opts.ttlSeconds ?? config.idempotency.ttlSeconds;
  const lockTtlSeconds = opts.lockTtlSeconds ?? config.idempotency.lockTtlSeconds;

  return async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = req.header('Idempotency-Key');
    if (!key) {
      next();
      return;
    }

    const redisKey = `idempotency:${key}`;
    const requestHash = hashRequest(req);

    try {
      const lockValue: StoredRecord = { status: 'in_progress', requestHash };
      const acquired = await opts.redis.set(redisKey, JSON.stringify(lockValue), 'EX', lockTtlSeconds, 'NX');

      if (acquired !== 'OK') {
        const existingRaw = await opts.redis.get(redisKey);
        if (!existingRaw) {
          // Lock expired between our failed NX and this GET (very small
          // window). Treat as a fresh request rather than blocking forever.
          next();
          return;
        }

        const existing: StoredRecord = JSON.parse(existingRaw);

        if (existing.requestHash !== requestHash) {
          res.status(422).json({
            error: 'idempotency_key_reused',
            message: 'This Idempotency-Key was already used with a different request payload.'
          });
          return;
        }

        if (existing.status === 'in_progress') {
          res.status(409).json({
            error: 'request_in_progress',
            message: 'A request with this Idempotency-Key is already being processed. Retry shortly.'
          });
          return;
        }

        // Completed - replay the original response so retries are safe.
        res.status(existing.responseStatus ?? 200).json(existing.responseBody);
        return;
      }

      // We hold the lock for this key. Wrap res.json so whatever the route
      // handler actually returns becomes the durable, replayable result.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const record: StoredRecord = {
          status: 'completed',
          requestHash,
          responseStatus: res.statusCode,
          responseBody: body
        };
        opts.redis
          .set(redisKey, JSON.stringify(record), 'EX', ttlSeconds)
          .catch((err) =>
            // eslint-disable-next-line no-console
            console.error('[idempotency] failed to persist result:', (err as Error).message)
          );
        return originalJson(body);
      }) as typeof res.json;

      next();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[idempotency] Redis error, failing open:', (err as Error).message);
      next();
    }
  };
}
