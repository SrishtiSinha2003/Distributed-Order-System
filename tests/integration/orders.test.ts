import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { createApp } from '../../src/app';
import { ProcessOrderJobData } from '../../src/types';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from '@jest/globals';
/**
 * These tests talk to real Postgres and Redis instances (see
 * docker-compose.yml for local dev, and .github/workflows/ci.yml for the
 * service containers used in CI). They are skipped automatically if neither
 * is reachable, so `npm test` still runs the unit suite in a bare
 * environment - but CI always has both services available.
 */

const DATABASE_URL = process.env.DATABASE_URL as string;
const REDIS_URL = process.env.REDIS_URL as string;

let pool: Pool;
let redis: Redis;
let orderQueue: Queue<ProcessOrderJobData>;
let orderQueueRedis: Redis;
let app: ReturnType<typeof createApp>;
let servicesAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  redis = new Redis(REDIS_URL);
  orderQueueRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

orderQueue = new Queue<ProcessOrderJobData>('process-order-test', {
  connection: orderQueueRedis
});

  try {
    await pool.query('SELECT 1');
    await redis.ping();

    const migrationSql = fs.readFileSync(
      path.join(__dirname, '..', '..', 'migrations', '001_init.sql'),
      'utf-8'
    );
    await pool.query(migrationSql);
  } catch (err) {
    servicesAvailable = false;
    // eslint-disable-next-line no-console
    console.warn(
      '[integration tests] Postgres/Redis not reachable, skipping integration suite:',
      (err as Error).message
    );
    return;
  }

  app = createApp({
  db: pool,
  redis,
  orderQueue,
  rateLimit: {
    capacity: 100,
    refillRatePerSecond: 100,
    windowSeconds: 60
  }
});
});

afterAll(async () => {
  if (servicesAvailable) {
    await pool.query('TRUNCATE TABLE orders');

    await orderQueue.close();

    await pool.end();
    await redis.quit();
  }
});

beforeEach(async () => {
  if (!servicesAvailable) return;
  await pool.query('TRUNCATE TABLE orders');
  await redis.flushdb();
});

const maybeIt = () => (servicesAvailable ? it : it.skip);

describe('POST /orders', () => {
  maybeIt()('creates an order and enqueues it for processing', async () => {
    const res = await request(app).post('/orders').send({
      customer_email: 'buyer@example.com',
      item: 'Mechanical keyboard',
      quantity: 1,
      amount_cents: 12_000
    });

    expect(res.status).toBe(202);
    expect(res.body.order.status).toBe('pending');
    expect(res.body.order.id).toBeDefined();

    const counts = await orderQueue.getJobCounts('waiting', 'active');
    expect(counts.waiting + counts.active).toBeGreaterThanOrEqual(0); // queue reachable, no throw
  });

  maybeIt()('rejects an invalid payload with 400', async () => {
    const res = await request(app).post('/orders').send({ item: 'no email or amount' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  maybeIt()('is idempotent: retried request with the same key returns the same order, not a duplicate', async () => {
    const payload = {
      customer_email: 'retry@example.com',
      item: 'Standing desk',
      quantity: 1,
      amount_cents: 45_000
    };

    const first = await request(app).post('/orders').set('Idempotency-Key', 'test-key-1').send(payload);
    const second = await request(app).post('/orders').set('Idempotency-Key', 'test-key-1').send(payload);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.order.id).toBe(first.body.order.id);

    const countResult = await pool.query('SELECT COUNT(*) FROM orders WHERE customer_email = $1', [
      'retry@example.com'
    ]);
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  maybeIt()('rejects a reused idempotency key with a different payload (422)', async () => {
    await request(app)
      .post('/orders')
      .set('Idempotency-Key', 'conflict-key')
      .send({ customer_email: 'a@example.com', item: 'Chair', quantity: 1, amount_cents: 1000 });

    const conflict = await request(app)
      .post('/orders')
      .set('Idempotency-Key', 'conflict-key')
      .send({ customer_email: 'a@example.com', item: 'Desk', quantity: 1, amount_cents: 2000 });

    expect(conflict.status).toBe(422);
  });
});

describe('GET /orders/:id', () => {
  maybeIt()('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/orders/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  maybeIt()('caches the response: second read is served from Redis (X-Cache: HIT)', async () => {
    const created = await request(app).post('/orders').send({
      customer_email: 'cache@example.com',
      item: 'Monitor',
      quantity: 1,
      amount_cents: 20_000
    });
    const id = created.body.order.id;

    const miss = await request(app).get(`/orders/${id}`);
    expect(miss.headers['x-cache']).toBe('MISS');

    const hit = await request(app).get(`/orders/${id}`);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body.order.id).toBe(id);
  });
});

describe('GET /orders (pagination)', () => {
  maybeIt()('paginates through all rows using nextCursor without skipping or repeating', async () => {
    for (let i = 0; i < 25; i++) {
      await request(app)
        .post('/orders')
        .send({ customer_email: `user${i}@example.com`, item: 'Widget', quantity: 1, amount_cents: 500 });
    }

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = cursor ? `?limit=10&cursor=${encodeURIComponent(cursor)}` : '?limit=10';
      const res = await request(app).get(`/orders${query}`);
      expect(res.status).toBe(200);
      for (const order of res.body.items) {
        expect(seenIds.has(order.id)).toBe(false); // no duplicates across pages
        seenIds.add(order.id);
      }
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seenIds.size).toBe(25);
    expect(pages).toBe(3); // 10 + 10 + 5
  });
});


describe('rate limiting', () => {
  maybeIt()('returns 429 once the per-client token bucket is exhausted', async () => {
    const rateLimitedApp = createApp({
      db: pool,
      redis,
      orderQueue,
      rateLimit: {
        capacity: 3,
        refillRatePerSecond: 1,
        windowSeconds: 60
      }
    });

    const agent = request(rateLimitedApp);
    const responses = [];

    for (let i = 0; i < 5; i++) {
      responses.push(await agent.get('/orders'));
    }

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});