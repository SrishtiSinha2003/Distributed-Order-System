import { createApp } from './app';
import { pool } from './db';
import { getRedis } from './redis';
import { createOrderQueue, createDeadLetterQueue } from './queue/orderQueue';
import { startOrderWorker } from './queue/orderWorker';
import { startNotificationWorker } from './queue/notificationWorker';
import { config } from './config';

async function main(): Promise<void> {
  const redis = getRedis();
  const orderQueue = createOrderQueue();
  const deadLetterQueue = createDeadLetterQueue();

  const app = createApp({ db: pool, redis, orderQueue});

  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on port ${config.port} (${config.nodeEnv})`);
  });

  // Free-tier accommodation (see config.ts) - on a host that only gives you
  // one free process, run the workers alongside the API instead of paying
  // for two extra background-worker services.
  let inProcessWorker: ReturnType<typeof startOrderWorker> | undefined;
  let inProcessNotificationWorker: ReturnType<typeof startNotificationWorker> | undefined;
  if (config.runWorkersInProcess) {
    inProcessWorker = startOrderWorker();
    inProcessNotificationWorker = startNotificationWorker();
    // eslint-disable-next-line no-console
    console.log('[server] RUN_WORKERS_IN_PROCESS=true - order and notification workers started in this process');
  }

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] received ${signal}, shutting down gracefully`);
    server.close(async () => {
      if (inProcessWorker) {
        await inProcessWorker.worker.close();
        await inProcessWorker.queueEvents.close();
      }
      if (inProcessNotificationWorker) {
        await inProcessNotificationWorker.close();
      }
      await orderQueue.close();
      await deadLetterQueue.close();
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
