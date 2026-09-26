import { Worker, Job } from 'bullmq';
import { config } from '../config';
import { SendConfirmationJobData } from '../types';
import { createQueueConnection } from './orderQueue';

/**
 * Stands in for an email/SMS provider call. In a real system this would hit
 * something like SES/Twilio; here we just log, so the pipeline
 * (process-order -> send-confirmation) is demonstrable end-to-end without
 * external accounts.
 */
export function startNotificationWorker(): Worker<SendConfirmationJobData> {
  const connection = createQueueConnection();

  const worker = new Worker<SendConfirmationJobData>(
    config.queue.notificationQueueName,
    async (job: Job<SendConfirmationJobData>) => {
      const { orderId, customerEmail } = job.data;
      // eslint-disable-next-line no-console
      console.log(`[notification-worker] sending confirmation for order ${orderId} to ${customerEmail}`);
      return { sent: true };
    },
    { connection, concurrency: 10 }
  );

  return worker;
}

/* istanbul ignore next */
if (require.main === module) {
  startNotificationWorker();
  // eslint-disable-next-line no-console
  console.log(`[notification-worker] listening on queue "${config.queue.notificationQueueName}"`);
}
