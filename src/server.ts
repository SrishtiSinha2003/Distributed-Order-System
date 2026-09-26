import { createApp } from './app';
import { pool } from './db';
import { getRedis } from './redis';
import { createOrderQueue } from './queue/orderQueue';
import { config } from './config';

async function main(): Promise<void> {
  const redis = getRedis();
  const orderQueue = createOrderQueue();

  const app = createApp({ db: pool, redis, orderQueue });

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  });

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down gracefully`);
    server.close(async () => {
      await orderQueue.close();
      await redis.quit();
      await pool.end();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
