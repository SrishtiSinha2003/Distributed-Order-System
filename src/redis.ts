import Redis, { Redis as RedisClient } from 'ioredis';
import { config } from './config';

let client: RedisClient | null = null;

/**
 * Returns a lazily-created singleton ioredis client.
 * BullMQ requires maxRetriesPerRequest: null on any connection it manages,
 * so queue/worker code creates its own dedicated connections (see queue/*.ts)
 * rather than reusing this one.
 */
export function getRedis(): RedisClient {
  if (!client) {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: false
    });
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[redis] connection error:', err.message);
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
