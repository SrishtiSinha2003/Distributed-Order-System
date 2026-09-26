import { describe, expect, it, jest } from '@jest/globals';
import RedisMock from 'ioredis-mock';
import { Request, Response } from 'express';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency';

function mockReqRes(opts: { key?: string; body?: unknown; path?: string } = {}) {
  const req = {
    header: (name: string) => (name === 'Idempotency-Key' ? opts.key : undefined),
    method: 'POST',
    path: opts.path ?? '/orders',
    body: opts.body ?? { item: 'widget' }
  } as unknown as Request;

  const res = {
    statusCode: 200,
    status: jest.fn(function (this: Response, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn()
  } as unknown as Response;

  return { req, res };
}

describe('idempotency middleware', () => {
  it('passes through untouched when no Idempotency-Key header is present', async () => {
    const redis = new RedisMock();
    const middleware = createIdempotencyMiddleware({ redis });
    const { req, res } = mockReqRes({ key: undefined });
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('lets the first request through and persists its actual response', async () => {
    const redis = new RedisMock();
    const middleware = createIdempotencyMiddleware({ redis });
    const { req, res } = mockReqRes({ key: 'abc-123' });
    const jsonMock = res.json;
    const next = jest.fn(() => {
      res.status(202);
      res.json({ order: { id: 'order-1' } });
    });

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({ order: { id: 'order-1' } });

    const stored = await redis.get('idempotency:abc-123');
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).status).toBe('completed');
  });

  it('replays the original response on a retried request with the same key and body', async () => {
    const redis = new RedisMock();
    const middleware = createIdempotencyMiddleware({ redis });

    const first = mockReqRes({ key: 'retry-key', body: { item: 'widget' } });
    await middleware(first.req, first.res, () => {
      first.res.status(202);
      first.res.json({ order: { id: 'order-42' } });
    });

    const second = mockReqRes({ key: 'retry-key', body: { item: 'widget' } });
    const nextSecond = jest.fn();
    await middleware(second.req, second.res, nextSecond);

    expect(nextSecond).not.toHaveBeenCalled(); // handler must NOT run twice
    expect(second.res.status).toHaveBeenCalledWith(202);
    expect(second.res.json).toHaveBeenCalledWith({ order: { id: 'order-42' } });
  });

  it('rejects a reused key with a different request body (422)', async () => {
    const redis = new RedisMock();
    const middleware = createIdempotencyMiddleware({ redis });

    const first = mockReqRes({ key: 'shared-key', body: { item: 'widget' } });
    await middleware(first.req, first.res, () => {
      first.res.status(202);
      first.res.json({ order: { id: 'order-1' } });
    });

    const second = mockReqRes({ key: 'shared-key', body: { item: 'a completely different item' } });
    const nextSecond = jest.fn();
    await middleware(second.req, second.res, nextSecond);

    expect(nextSecond).not.toHaveBeenCalled();
    expect(second.res.status).toHaveBeenCalledWith(422);
    expect(second.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'idempotency_key_reused' })
    );
  });

  it('returns 409 for a concurrent duplicate while the first request is still in flight', async () => {
    const redis = new RedisMock();
    const middleware = createIdempotencyMiddleware({ redis, lockTtlSeconds: 30 });

    const first = mockReqRes({ key: 'in-flight-key' });
    const firstNext = jest.fn(); // deliberately never resolves the "handler" -> lock stays held

    await middleware(first.req, first.res, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);

    const second = mockReqRes({ key: 'in-flight-key' });
    const secondNext = jest.fn();
    await middleware(second.req, second.res, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(second.res.status).toHaveBeenCalledWith(409);
    expect(second.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'request_in_progress' })
    );
  });
});
