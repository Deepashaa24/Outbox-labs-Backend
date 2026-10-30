import { Worker } from "bullmq";
import { config } from "../config/env.js";
import { elasticsearch } from "../config/elasticsearch.js";
import { redis } from "../config/redis.js";
import { prisma } from "../db/prisma.js";
import { emailQueue, EMAIL_QUEUE_NAME } from "../queues/emailQueue.js";
import { ensureEmailsIndex } from "../services/integrationService.js";
import { reconcileScheduledEmails, recoverStuckProcessingJobs } from "../services/schedulingService.js";
import { createEmailProcessor } from "./emailProcessor.js";

let worker: Worker | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down email worker.`);

  const errors: unknown[] = [];
  if (worker) {
    try {
      await worker.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await emailQueue.close();
  } catch (error) {
    errors.push(error);
  }
  const results = await Promise.allSettled([
    redis.quit(),
    prisma.$disconnect(),
    elasticsearch.close()
  ]);
  errors.push(
    ...results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
  );
  if (errors.length > 0) {
    console.error("Email worker shutdown failed.", errors);
    process.exitCode = 1;
  }
}

async function startWorker(): Promise<void> {
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await prisma.$connect();
  await redis.ping();
  void ensureEmailsIndex().catch((error: unknown) => {
    console.warn("Could not ensure the Elasticsearch email index.", error);
  });
  await recoverStuckProcessingJobs();
  await reconcileScheduledEmails();

  if (shuttingDown) return;
  worker = new Worker(EMAIL_QUEUE_NAME, createEmailProcessor(), {
    connection: redis,
    concurrency: config.WORKER_CONCURRENCY,
    ...(config.MIN_DELAY_BETWEEN_EMAILS_MS > 0
      ? {
          limiter: {
            max: 1,
            duration: config.MIN_DELAY_BETWEEN_EMAILS_MS
          }
        }
      : {})
  });

  worker.on("failed", (job, error) => {
    console.error(`Email queue job ${job?.id ?? "unknown"} failed.`, error);
  });

  worker.on("error", (error) => {
    console.error("Email worker encountered an error.", error);
  });
  console.info(`Email worker started with concurrency ${config.WORKER_CONCURRENCY}.`);
}

startWorker().catch(async (error: unknown) => {
  console.error("Email worker startup failed.", error);
  await shutdown("startup failure");
  process.exitCode = 1;
});
