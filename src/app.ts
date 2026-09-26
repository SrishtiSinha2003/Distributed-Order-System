import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import type { Redis as RedisClient } from 'ioredis';
import type { Queue } from 'bullmq';
import { createRateLimiter } from './middleware/rateLimiter';
import { createIdempotencyMiddleware } from './middleware/idempotency';
import { createOrdersRouter } from './routes/orders';
import { OrderService } from './services/orderService';
import { ProcessOrderJobData } from './types';
import { Pool } from 'pg';

export interface AppDeps {
  db: Pool;
  redis: RedisClient;
  orderQueue: Queue<ProcessOrderJobData>;
  rateLimit?: {
    capacity?: number;
    refillRatePerSecond?: number;
    windowSeconds?: number;
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

  app.use(
  createRateLimiter({
    redis: deps.redis,
    ...deps.rateLimit
  })
);

  const orderService = new OrderService(deps.db);

  // Idempotency only matters for the mutating endpoint; GETs are naturally
  // idempotent so we scope the middleware to POST /orders alone rather than
  // applying it globally.
  app.post('/orders', createIdempotencyMiddleware({ redis: deps.redis }));

  app.use(
    '/',
    createOrdersRouter({
      orderService,
      redis: deps.redis,
      orderQueue: deps.orderQueue
    })
  );

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` });
  });

  // Centralized error handler so route handlers can stay free of try/catch
  // boilerplate for unexpected errors (validation errors are handled inline).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[app] unhandled error:', err);
    res.status(500).json({ error: 'internal_error', message: 'Something went wrong' });
  });

  return app;
}
