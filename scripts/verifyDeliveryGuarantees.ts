import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { EmailJobStatus } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import { config } from "../src/config/env.js";
import { redis } from "../src/config/redis.js";
import { prisma } from "../src/db/prisma.js";
import type { EmailQueuePayload } from "../src/queues/emailQueue.js";
import { getRateLimitKey } from "../src/services/rateLimitService.js";
import { createEmailProcessor } from "../src/workers/emailProcessor.js";

const runId = randomUUID();
const queueNames = [
  `verify-idempotency-${runId}`,
  `verify-concurrency-${runId}`,
  `verify-rate-limit-${runId}`
];
const queues = new Map<string, Queue<EmailQueuePayload>>();
const userId = randomUUID();
const senderIds = [randomUUID(), randomUUID(), randomUUID()];
const batchIds = [randomUUID(), randomUUID(), randomUUID()];
const errorMessages: string[] = [];
let redisErrorReported = false;

redis.on("error", (error: Error) => {
  if (redisErrorReported) return;
  redisErrorReported = true;
  console.error("Verification Redis connection error.", error.message);
});

function createQueue(name: string): Queue<EmailQueuePayload> {
  const queue = new Queue<EmailQueuePayload>(name, {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
      attempts: 1
    }
  });
  queues.set(name, queue);
  return queue;
}

async function createScenarioJobs(
  senderId: string,
  batchId: string,
  count: number,
  hourlyLimit: number,
  scheduledAt: Date
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const rows = ids.map((id, index) => ({
    id,
    toEmail: `${id}@example.test`,
    subject: `Delivery verification ${index}`,
    body: "This job is processed by a deterministic test transport.",
    scheduledAt: new Date(scheduledAt.getTime() + index * 10),
    status: EmailJobStatus.SCHEDULED,
    batchId,
    hourlyLimit,
    senderId,
    userId
  }));
  await prisma.emailJob.createMany({ data: rows });
  return ids;
}

async function addJobs(
  queue: Queue<EmailQueuePayload>,
  ids: string[],
  hourlyLimit: number
): Promise<void> {
  await queue.addBulk(ids.map((emailJobId) => ({
    name: "deliver",
    data: { emailJobId, hourlyLimit },
    opts: { jobId: emailJobId, delay: 0 }
  })));
}

function createTestWorker(
  queueName: string,
  concurrency: number,
  sendEmail: (recipient: string) => Promise<string | null>
): Worker<EmailQueuePayload> {
  const processor = createEmailProcessor({
    sendEmail: async (_sender, recipient) => sendEmail(recipient),
    updateSearchDocument: async () => undefined,
    notifySent: async () => undefined,
    notifyRateLimit: async () => undefined
  });

  const worker = new Worker<EmailQueuePayload>(queueName, processor, {
    connection: redis,
    concurrency
  });
  worker.on("failed", (job, error) => {
    errorMessages.push(`Queue ${queueName}, job ${job?.id ?? "unknown"} failed: ${error.message}`);
  });
  worker.on("error", (error) => {
    errorMessages.push(`Queue ${queueName} error: ${error.message}`);
  });
  return worker;
}

async function waitFor(
  description: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errorMessages.length > 0) throw new Error(errorMessages.join("\n"));
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function getJobs(ids: string[]) {
  return prisma.emailJob.findMany({
    where: { id: { in: ids } },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }]
  });
}

async function verifyIdempotency(): Promise<void> {
  const queue = createQueue(queueNames[0]!);
  const ids = await createScenarioJobs(
    senderIds[0]!,
    batchIds[0]!,
    1,
    Math.max(50, config.MAX_EMAILS_PER_HOUR_PER_SENDER),
    new Date(Date.now() - 1_000)
  );
  const jobId = ids[0]!;
  const payload = { emailJobId: jobId, hourlyLimit: Math.max(50, config.MAX_EMAILS_PER_HOUR_PER_SENDER) };

  const first = await queue.add("deliver", payload, { jobId, delay: 0, removeOnComplete: false });
  const second = await queue.add("deliver", payload, { jobId, delay: 0, removeOnComplete: false });
  assert.equal(first.id, second.id, "Duplicate enqueue should reuse the deterministic BullMQ job ID");

  const sends = new Map<string, number>();
  const worker = createTestWorker(queueNames[0]!, 5, async (id) => {
    const jobId = id.slice(0, id.indexOf("@"));
    sends.set(jobId, (sends.get(jobId) ?? 0) + 1);
    await sleep(50);
    return null;
  });

  try {
    await waitFor("idempotent job completion", async () =>
      (await prisma.emailJob.findUnique({ where: { id: jobId } }))?.status === EmailJobStatus.SENT
    );
    assert.equal(sends.get(jobId), 1, "The duplicate enqueue must invoke the sender exactly once");
    const storedJob = await queue.getJob(jobId);
    assert.ok(storedJob, "Completed queue entry should remain available for the test");
    assert.equal((await queue.getJobCounts("completed")).completed, 1);
    console.info("PASS idempotency: enqueueing the same database ID twice sends once.");
  } finally {
    await worker.close();
  }
}

async function verifyConcurrency(): Promise<void> {
  assert.ok(config.MAX_EMAILS_PER_HOUR_PER_SENDER >= 50,
    "Set MAX_EMAILS_PER_HOUR_PER_SENDER to at least 50 for the concurrency test.");
  const queue = createQueue(queueNames[1]!);
  const ids = await createScenarioJobs(
    senderIds[1]!,
    batchIds[1]!,
    50,
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    new Date(Date.now() - 1_000)
  );
  await addJobs(queue, ids, config.MAX_EMAILS_PER_HOUR_PER_SENDER);

  const sends = new Map<string, number>();
  let activeSends = 0;
  let maximumActiveSends = 0;
  const worker = createTestWorker(queueNames[1]!, 5, async (id) => {
    const jobId = id.slice(0, id.indexOf("@"));
    sends.set(jobId, (sends.get(jobId) ?? 0) + 1);
    activeSends += 1;
    maximumActiveSends = Math.max(maximumActiveSends, activeSends);
    await sleep(40);
    activeSends -= 1;
    return null;
  });

  try {
    await waitFor("all concurrent jobs to complete", async () => {
      const jobs = await getJobs(ids);
      return jobs.length === ids.length && jobs.every((job) => job.status === EmailJobStatus.SENT);
    });

    const jobs = await getJobs(ids);
    assert.equal(jobs.length, 50);
    assert.ok(maximumActiveSends <= 5, `Observed ${maximumActiveSends} concurrent sends, expected at most 5`);
    assert.equal(maximumActiveSends, 5, "The test should exercise all five worker slots");
    assert.ok(jobs.every((job) => job.attempts === 1), "Each job should enter SMTP delivery once");
    assert.ok(ids.every((id) => sends.get(id) === 1), "Each email should be sent exactly once");
    console.info("PASS concurrency: 50 jobs at concurrency 5 have no duplicate sends.");
  } finally {
    await worker.close();
  }
}

async function verifyRateLimit(): Promise<void> {
  assert.ok(config.MAX_EMAILS_PER_HOUR_PER_SENDER >= 5,
    "Set MAX_EMAILS_PER_HOUR_PER_SENDER to at least 5 for the rate-limit test.");
  const queue = createQueue(queueNames[2]!);
  const senderId = senderIds[2]!;
  const start = new Date(Date.now() - 10_000);
  const ids = await createScenarioJobs(senderId, batchIds[2]!, 20, 5, start);
  const rateKey = getRateLimitKey(senderId, Date.now());
  await redis.del(rateKey);
  await addJobs(queue, ids, 5);

  const sends = new Map<string, number>();
  const worker = createTestWorker(queueNames[2]!, 5, async (id) => {
    const jobId = id.slice(0, id.indexOf("@"));
    sends.set(jobId, (sends.get(jobId) ?? 0) + 1);
    await sleep(25);
    return null;
  });

  try {
    await waitFor("five sends and fifteen deferred jobs", async () => {
      const jobs = await getJobs(ids);
      return jobs.length === 20 && jobs.filter((job) => job.status === EmailJobStatus.SENT).length === 5 &&
        jobs.filter((job) => job.status === EmailJobStatus.SCHEDULED && job.scheduledAt.getTime() > Date.now()).length === 15;
    });

    const jobs = await getJobs(ids);
    const sentJobs = jobs.filter((job) => job.status === EmailJobStatus.SENT);
    const scheduledJobs = jobs.filter((job) => job.status === EmailJobStatus.SCHEDULED);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const deferredInOriginalOrder = ids
      .map((id) => jobsById.get(id))
      .filter((job) => job?.status === EmailJobStatus.SCHEDULED);
    const delayedCount = (await queue.getJobCounts("delayed")).delayed;
    assert.equal(sentJobs.length, 5);
    assert.equal(scheduledJobs.length, 15);
    assert.equal(delayedCount, 15);
    assert.equal(Number(await redis.get(rateKey)), 5, "Atomic Redis counter should be exactly five");
    assert.ok(scheduledJobs.every((job) => job.scheduledAt.getTime() >= Date.now()),
      "Deferred jobs should have future scheduledAt values");

    for (let index = 1; index < deferredInOriginalOrder.length; index += 1) {
      assert.ok(
        deferredInOriginalOrder[index]!.scheduledAt.getTime() >
          deferredInOriginalOrder[index - 1]!.scheduledAt.getTime(),
        "Deferred jobs should retain their original ordering"
      );
    }
    assert.equal(sends.size, 5, "Only five unique jobs should reach the sender");
    console.info("PASS rate limit: 5 of 20 send; 15 are delayed to the next hour in original order.");
  } finally {
    await worker.close();
  }
}

async function main(): Promise<void> {
  let databaseConnected = false;
  try {
    await prisma.$connect();
    databaseConnected = true;
    const pingTimeout = setTimeout(() => {
      redis.disconnect();
    }, 5_000);
    pingTimeout.unref();
    try {
      await redis.ping();
    } finally {
      clearTimeout(pingTimeout);
    }
    assert.ok(config.MAX_EMAILS_PER_HOUR_PER_SENDER >= 50,
      "Set MAX_EMAILS_PER_HOUR_PER_SENDER to at least 50 to run all verification cases.");

    await prisma.user.create({
      data: {
        id: userId,
        email: `delivery-verification-${runId}@example.test`,
        name: "Delivery verification"
      }
    });
    for (const [index, senderId] of senderIds.entries()) {
      await prisma.sender.create({
        data: {
          id: senderId,
          name: `Verification sender ${index + 1}`,
          smtpHost: "127.0.0.1",
          smtpPort: 2525,
          smtpSecure: false,
          smtpUser: `verification-${runId}-${index}@example.test`,
          smtpPass: "not-used-by-test-transport",
          userId
        }
      });
    }

    await verifyIdempotency();
    await verifyConcurrency();
    await verifyRateLimit();
  } finally {
    for (const [name, queue] of queues) {
      try {
        await queue.obliterate({ force: true });
      } catch (error) {
        console.error(`Could not clean verification queue ${name}.`, error);
      }
      await queue.close();
    }
    if (databaseConnected) {
      await prisma.emailJob.deleteMany({ where: { userId } });
      await prisma.sender.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    try {
      if (redis.status === "ready") {
        for (const senderId of senderIds) {
          await redis.del(getRateLimitKey(senderId, Date.now()));
        }
      }
    } finally {
      const cleanup = [
        ...(databaseConnected ? [prisma.$disconnect()] : []),
        redis.status === "ready" ? redis.quit() : Promise.resolve(redis.disconnect())
      ];
      await Promise.all(cleanup);
    }
  }
}

main().catch((error: unknown) => {
  console.error("Delivery guarantee verification failed.", error);
  process.exitCode = 1;
});
