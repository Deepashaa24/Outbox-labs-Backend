import { Queue } from "bullmq";
import { config } from "../config/env.js";
import { redis } from "../config/redis.js";

export const EMAIL_QUEUE_NAME = "email-delivery";

export interface EmailQueuePayload {
  emailJobId: string;
  batchId?: string | null;
  hourlyLimit?: number;
}

export const emailQueue = new Queue<EmailQueuePayload>(EMAIL_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: config.JOB_RETRY_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: config.JOB_RETRY_BACKOFF_DELAY_MS
    },
    removeOnComplete: {
      age: config.JOB_RETENTION_DAYS * 24 * 60 * 60
    },
    removeOnFail: false
  }
});
