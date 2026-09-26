import { Router, Request, Response } from 'express';
import type { Redis as RedisClient } from 'ioredis';
import type { Queue } from 'bullmq';
import { OrderService, InvalidCursorError } from '../services/orderService';
import { ProcessOrderJobData, CreateOrderInput } from '../types';
import { enqueueOrderProcessing } from '../queue/orderQueue';
import { config } from '../config';

export interface OrdersRouteDeps {
  orderService: OrderService;
  redis: RedisClient;
  orderQueue: Queue<ProcessOrderJobData>;
}

function validateCreateOrderInput(body: unknown): { valid: true; data: CreateOrderInput } | { valid: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.customer_email !== 'string' || !b.customer_email.includes('@')) {
    return { valid: false, error: 'customer_email must be a valid email string' };
  }
  if (typeof b.item !== 'string' || b.item.trim().length === 0) {
    return { valid: false, error: 'item must be a non-empty string' };
  }
  if (typeof b.quantity !== 'number' || !Number.isInteger(b.quantity) || b.quantity <= 0) {
    return { valid: false, error: 'quantity must be a positive integer' };
  }
  if (typeof b.amount_cents !== 'number' || !Number.isInteger(b.amount_cents) || b.amount_cents <= 0) {
    return { valid: false, error: 'amount_cents must be a positive integer' };
  }
  return {
    valid: true,
    data: {
      customer_email: b.customer_email,
      item: b.item,
      quantity: b.quantity,
      amount_cents: b.amount_cents
    }
  };
}

export function createOrdersRouter(deps: OrdersRouteDeps): Router {
  const router = Router();
  const { orderService, redis, orderQueue } = deps;

  // POST /orders - creates an order, then hands off async processing to the
  // queue. Returns 202 Accepted (not 201) because the order is not yet
  // finished processing - the client should poll GET /orders/:id or listen
  // for a webhook/notification in a real system.
  router.post('/orders', async (req: Request, res: Response) => {
    const validation = validateCreateOrderInput(req.body);
    if (!validation.valid) {
      res.status(400).json({ error: 'validation_error', message: validation.error });
      return;
    }

    const idempotencyKey = req.header('Idempotency-Key') ?? null;
    const order = await orderService.createOrder(validation.data, idempotencyKey);
    await enqueueOrderProcessing(orderQueue, { orderId: order.id });

    res.status(202).json({ order });
  });

  // GET /orders/:id - cache-aside read. Cache is invalidated by the worker
  // whenever an order's status changes, so it can never serve stale
  // "pending" for more than config.cache.orderTtlSeconds in the worst case.
  router.get('/orders/:id', async (req: Request, res: Response) => {
    const cacheKey = `cache:order:${req.params.id}`;

    const cached = await redis.get(cacheKey).catch(() => null);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.status(200).json({ order: JSON.parse(cached) });
      return;
    }

    const order = await orderService.getOrderById(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'not_found', message: 'No order with that id' });
      return;
    }

    res.setHeader('X-Cache', 'MISS');
    await redis.set(cacheKey, JSON.stringify(order), 'EX', config.cache.orderTtlSeconds).catch(() => undefined);
    res.status(200).json({ order });
  });

  // GET /orders?limit=20&cursor=... - keyset pagination. Only the very
  // first page (no cursor, default limit) is cached, since it's by far the
  // hottest read in a typical "recent orders" dashboard; deeper pages are
  // fetched live because it's not memory-efficient to cache every distinct
  // cursor.
  router.get('/orders', async (req: Request, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

    if (!Number.isFinite(limit) || limit <= 0) {
      res.status(400).json({ error: 'validation_error', message: 'limit must be a positive number' });
      return;
    }

    const isCacheableFirstPage = !cursor && limit === 20;
    const cacheKey = 'cache:orders:first-page';

    if (isCacheableFirstPage) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.status(200).json(JSON.parse(cached));
        return;
      }
    }

    try {
      const result = await orderService.listOrders(limit, cursor);
      if (isCacheableFirstPage) {
        res.setHeader('X-Cache', 'MISS');
        await redis.set(cacheKey, JSON.stringify(result), 'EX', config.cache.orderTtlSeconds).catch(() => undefined);
      }
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        res.status(400).json({ error: 'invalid_cursor', message: err.message });
        return;
      }
      throw err;
    }
  });

  return router;
}
