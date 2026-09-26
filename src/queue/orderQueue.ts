import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';
import { ProcessOrderJobData, SendConfirmationJobData } from '../types';

/**
 * BullMQ requires its own Redis connection(s) with maxRetriesPerRequest set
 * to null (it manages retry/backoff itself via blocking commands). We give
 * queues and workers dedicated connections rather than sharing the app's
 * general-purpose Redis client from src/redis.ts.
 */
export function createQueueConnection(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

export function createOrderQueue(connection: Redis = createQueueConnection()): Queue<ProcessOrderJobData> {
  return new Queue<ProcessOrderJobData>(config.queue.orderQueueName, { connection });
}

export function createNotificationQueue(
  connection: Redis = createQueueConnection()
): Queue<SendConfirmationJobData> {
  return new Queue<SendConfirmationJobData>(config.queue.notificationQueueName, { connection });
}

export function createDeadLetterQueue(connection: Redis = createQueueConnection()): Queue {
  return new Queue(config.queue.deadLetterQueueName, { connection });
}

/**
 * Enqueue a new order for asynchronous processing.
 *
 * At-least-once delivery: BullMQ jobs are persisted in Redis before this
 * call returns and are only removed once a worker explicitly acknowledges
 * completion. If a worker crashes mid-job, BullMQ's stalled-job detection
 * (checked via the QueueEvents/Worker lock renewal mechanism) returns the
 * job to the queue for another worker to pick up - so a job may be
 * processed more than once (hence "at-least-once", not "exactly-once").
 * The order-processing handler is written to be idempotent per orderId to
 * tolerate that.
 */
export async function enqueueOrderProcessing(
  queue: Queue<ProcessOrderJobData>,
  data: ProcessOrderJobData
): Promise<void> {
  await queue.add('process-order', data, {
    jobId: `order-${data.orderId}`, // de-dupes repeated enqueues for the same order
    attempts: config.queue.maxAttempts,
    backoff: {
      type: 'exponential',
      delay: config.queue.backoffBaseMs
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: false // keep failed jobs around until the DLQ handler moves them
  });
}

export function createQueueEvents(connection: Redis = createQueueConnection()): QueueEvents {
  return new QueueEvents(config.queue.orderQueueName, { connection });
}
