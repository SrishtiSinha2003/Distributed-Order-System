import { Worker, Job, QueueEvents } from 'bullmq';
import { pool } from '../db';
import { getRedis } from '../redis';
import { config } from '../config';
import { OrderService } from '../services/orderService';
import { ProcessOrderJobData } from '../types';
import { createDeadLetterQueue, createNotificationQueue, createQueueConnection } from './orderQueue';

const orderService = new OrderService(pool);

/**
 * Simulates a flaky downstream dependency (e.g. a payment provider) so the
 * retry/backoff machinery has something real to demonstrate. Roughly 30% of
 * attempts fail transiently.
 */
async function chargePaymentProvider(orderId: string): Promise<void> {
  const shouldFail = Math.random() < 0.3;
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (shouldFail) {
    throw new Error(`Simulated transient payment failure for order ${orderId}`);
  }
}

async function invalidateOrderCache(orderId: string): Promise<void> {
  await getRedis().del(`cache:order:${orderId}`);
  await getRedis().del('cache:orders:first-page');
}

export function startOrderWorker(): { worker: Worker<ProcessOrderJobData>; queueEvents: QueueEvents } {
  const workerConnection = createQueueConnection();
  const queueEventsConnection = createQueueConnection();
  const notificationQueue = createNotificationQueue();
  const deadLetterQueue = createDeadLetterQueue();

  const worker = new Worker<ProcessOrderJobData>(
    config.queue.orderQueueName,
    async (job: Job<ProcessOrderJobData>) => {
      const { orderId } = job.data;

      // Idempotent guard: if a previous attempt already completed this order
      // (e.g. it succeeded but the ack was lost, and BullMQ redelivered it),
      // skip re-charging the customer. This is what makes at-least-once
      // delivery safe to build on.
      const existing = await orderService.getOrderById(orderId);
      if (!existing) {
        throw new Error(`Order ${orderId} not found - cannot process`);
      }
      if (existing.status === 'completed') {
        return { alreadyCompleted: true };
      }

      await orderService.updateStatus(orderId, 'processing');

      try {
        await chargePaymentProvider(orderId);
      } catch (err) {
        // Re-throw so BullMQ counts this as a failed attempt and schedules
        // a retry with exponential backoff (see queue/orderQueue.ts opts).
        await orderService.updateStatus(orderId, 'pending');
        throw err;
      }

      await orderService.updateStatus(orderId, 'completed');
      await invalidateOrderCache(orderId);

      await notificationQueue.add(
        'send-confirmation',
        { orderId, customerEmail: existing.customer_email },
        { attempts: 3, backoff: { type: 'exponential', delay: 500 } }
      );

      return { success: true };
    },
    { connection: workerConnection, concurrency: 5 }
  );

  const queueEvents = new QueueEvents(config.queue.orderQueueName, { connection: queueEventsConnection });

  // Once a job has exhausted every retry attempt, BullMQ marks it "failed"
  // for good. We treat that as our dead-letter trigger: record the terminal
  // state on the order and hand the job payload to a dead-letter queue so a
  // human/ops process can inspect and optionally replay it later.
  queueEvents.on('failed', async ({ jobId, failedReason }) => {
    const job = await Job.fromId<ProcessOrderJobData>(worker, jobId);
    if (!job) return;

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? config.queue.maxAttempts;

    if (attemptsMade >= maxAttempts) {
      await orderService.updateStatus(job.data.orderId, 'dead_letter');
      await deadLetterQueue.add('dead-letter', {
        originalJobId: jobId,
        orderId: job.data.orderId,
        failedReason,
        attemptsMade,
        failedAt: new Date().toISOString()
      });
      // eslint-disable-next-line no-console
      console.error(`[worker] order ${job.data.orderId} moved to dead-letter after ${attemptsMade} attempts`);
    }
  });

  worker.on('completed', (job) => {
    // eslint-disable-next-line no-console
    console.log(`[worker] order ${job.data.orderId} processed successfully`);
  });

  return { worker, queueEvents };
}

/* istanbul ignore next -- exercised via integration tests, not run as a script during unit tests */
if (require.main === module) {
  startOrderWorker();
  // eslint-disable-next-line no-console
  console.log(`[worker] listening on queue "${config.queue.orderQueueName}"`);
}
