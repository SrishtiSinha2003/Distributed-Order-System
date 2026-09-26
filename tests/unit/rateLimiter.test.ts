import RedisMock from 'ioredis-mock';
import { Request, Response } from 'express';
import { createRateLimiter } from '../../src/middleware/rateLimiter';

function mockReqRes(ip = '127.0.0.1') {
  const req = { ip } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: jest.fn(function (this: Response, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn()
  } as unknown as Response;
  return { req, res, headers };
}

describe('token bucket rate limiter', () => {
  it('allows requests up to the bucket capacity, then blocks with 429', async () => {
    const redis = new RedisMock();
    const limiter = createRateLimiter({
      redis,
      capacity: 3,
      refillRatePerSecond: 0, // no refill mid-test, isolates the capacity behaviour
      windowSeconds: 60,
      keyFn: () => 'test:client-a'
    });

    for (let i = 0; i < 3; i++) {
      const { req, res } = mockReqRes();
      const next = jest.fn();
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const { req, res } = mockReqRes();
    const next = jest.fn();
    await limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'rate_limited' })
    );
  });

  it('tracks separate buckets per client key', async () => {
    const redis = new RedisMock();
    const limiter = createRateLimiter({
      redis,
      capacity: 1,
      refillRatePerSecond: 0,
      windowSeconds: 60,
      keyFn: (req) => `test:${req.ip}`
    });

    const clientA = mockReqRes('1.1.1.1');
    const nextA = jest.fn();
    await limiter(clientA.req, clientA.res, nextA);
    expect(nextA).toHaveBeenCalled();

    // Client A is now out of tokens...
    const clientAagain = mockReqRes('1.1.1.1');
    const nextAagain = jest.fn();
    await limiter(clientAagain.req, clientAagain.res, nextAagain);
    expect(nextAagain).not.toHaveBeenCalled();

    // ...but client B has an independent bucket and is unaffected.
    const clientB = mockReqRes('2.2.2.2');
    const nextB = jest.fn();
    await limiter(clientB.req, clientB.res, nextB);
    expect(nextB).toHaveBeenCalled();
  });

  it('refills tokens over time', async () => {
    const redis = new RedisMock();
    const limiter = createRateLimiter({
      redis,
      capacity: 1,
      refillRatePerSecond: 100, // fast refill so the test doesn't need to sleep long
      windowSeconds: 60,
      keyFn: () => 'test:refill'
    });

    const first = mockReqRes();
    await limiter(first.req, first.res, jest.fn());

    const second = mockReqRes();
    const nextSecond = jest.fn();
    await limiter(second.req, second.res, nextSecond);
    expect(nextSecond).not.toHaveBeenCalled(); // bucket just spent its only token

    await new Promise((resolve) => setTimeout(resolve, 50)); // ~5 tokens refill at 100/s

    const third = mockReqRes();
    const nextThird = jest.fn();
    await limiter(third.req, third.res, nextThird);
    expect(nextThird).toHaveBeenCalled();
  });

  it('fails open (lets the request through) if Redis errors', async () => {
    const brokenRedis = {
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    } as never;

    const limiter = createRateLimiter({ redis: brokenRedis, capacity: 1, refillRatePerSecond: 1 });
    const { req, res } = mockReqRes();
    const next = jest.fn();

    await limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
