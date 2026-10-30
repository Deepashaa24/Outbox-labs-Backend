import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { EmailJobStatus } from "@prisma/client";
import { config } from "../src/config/env.js";

const RECIPIENT_COUNT = 5;
const START_DELAY_MS = 2 * 60 * 1000;
const MAX_DELIVERY_LATENESS_MS = 60 * 1000;
const apiUrl = (process.env.SMOKE_TEST_API_URL ?? `http://localhost:${config.PORT}`)
  .replace(/\/+$/, "");

interface ScheduledRow {
  id: string;
  scheduledAt: Date;
  status: EmailJobStatus;
  attempts: number;
  sentAt: Date | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${description} was not an object.`);
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} was missing.`);
  }
  return value;
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = isRecord(body) && typeof body.error === "string"
      ? body.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function runCheck(label: string, operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation();
    console.info(`PASS ${label}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`FAIL ${label}: ${message}`);
    return false;
  }
}

function getSessionCookie(): string {
  const token = process.env.SMOKE_TEST_SESSION_COOKIE?.trim();
  if (!token) {
    throw new Error(
      "Set SMOKE_TEST_SESSION_COOKIE to the value of the email_scheduler_session cookie after signing in."
    );
  }
  return `email_scheduler_session=${token}`;
}

function getRecipients(): string[] {
  const recipients = process.env.SMOKE_TEST_RECIPIENTS
    ?.split(",")
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean);

  if (!recipients || recipients.length !== RECIPIENT_COUNT) {
    throw new Error("SMOKE_TEST_RECIPIENTS must contain exactly five comma-separated email addresses.");
  }
  if (new Set(recipients).size !== RECIPIENT_COUNT) {
    throw new Error("SMOKE_TEST_RECIPIENTS must contain five unique email addresses.");
  }
  return recipients;
}

async function assertApiAvailable(): Promise<void> {
  const response = await fetch(`${apiUrl}/health`);
  if (!response.ok) throw new Error(`API health check failed with HTTP ${response.status}.`);
}

async function main(): Promise<void> {
  const recipients = getRecipients();
  const cookie = getSessionCookie();
  const client = createInterface({ input: stdin, output: stdout });
  const [{ prisma }, { redis }, { emailQueue }, { enqueueEmail }] = await Promise.all([
    import("../src/db/prisma.js"),
    import("../src/config/redis.js"),
    import("../src/queues/emailQueue.js"),
    import("../src/services/schedulingService.js")
  ]);
  let scheduledRows: ScheduledRow[] = [];
  let userId = "";
  let batchId = "";
  let scheduleCheckPassed = false;
  let restartCheckPassed = false;
  let duplicateCheckPassed = false;

  try {
    scheduleCheckPassed = await runCheck(
      "1. Five scheduled rows and five delayed BullMQ jobs have matching IDs",
      async () => {
        await prisma.$connect();
        await redis.ping();
        await assertApiAvailable();

        const userResponse = await fetch(`${apiUrl}/api/me`, {
          headers: { cookie }
        });
        const userBody = requireRecord(await responseJson(userResponse), "Current-user response");
        const user = requireRecord(userBody.data, "Current user");
        userId = requireString(user.id, "Current-user ID");

        const senders = await prisma.sender.findMany({
          where: { userId },
          select: { smtpHost: true }
        });
        if (senders.length === 0 || senders.some((sender) => sender.smtpHost !== "smtp.ethereal.email")) {
          throw new Error("The signed-in user must have Ethereal SMTP senders; refusing to send through other hosts.");
        }

        const requestedStartTime = new Date(Date.now() + START_DELAY_MS);
        const scheduleResponse = await fetch(`${apiUrl}/api/emails/schedule`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            subject: `Smoke test ${new Date().toISOString()}`,
            body: "Ethereal delivery/restart smoke test.",
            recipients,
            startTime: requestedStartTime.toISOString(),
            delayBetweenMs: 2000,
            hourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER
          })
        });
        const scheduleBody = requireRecord(
          await responseJson(scheduleResponse),
          "Schedule response"
        );
        batchId = requireString(scheduleBody.batchId, "Schedule batch ID");

        scheduledRows = await prisma.emailJob.findMany({
          where: { userId, batchId },
          orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
          select: { id: true, scheduledAt: true, status: true, attempts: true, sentAt: true }
        });
        if (scheduledRows.length !== RECIPIENT_COUNT) {
          throw new Error(`Expected five database rows, found ${scheduledRows.length}.`);
        }

        for (const [index, row] of scheduledRows.entries()) {
          const expectedTime = requestedStartTime.getTime() + index * 2000;
          if (row.status !== EmailJobStatus.SCHEDULED || row.attempts !== 0 || row.sentAt !== null) {
            throw new Error(`EmailJob ${row.id} did not start in SCHEDULED state.`);
          }
          if (row.scheduledAt.getTime() !== expectedTime) {
            throw new Error(`EmailJob ${row.id} has an unexpected scheduled time.`);
          }

          const queueJob = await emailQueue.getJob(row.id);
          if (!queueJob || queueJob.id !== row.id || queueJob.data.emailJobId !== row.id) {
            throw new Error(`BullMQ job ${row.id} is missing or has a mismatched jobId/payload.`);
          }
          if (await queueJob.getState() !== "delayed") {
            throw new Error(`BullMQ job ${row.id} is not delayed.`);
          }
        }
      }
    );

    if (scheduleCheckPassed) {
      await client.question(
        "\nNow stop the API and worker, restart both before the first scheduled time, then press Enter here. Keep this smoke-test process running. "
      );

      restartCheckPassed = await runCheck(
        "2. Restart recovers all five jobs and each sends once at/after its scheduled time",
        async () => {
          await assertApiAvailable();
          const lastDueTime = scheduledRows.at(-1)?.scheduledAt.getTime();
          if (lastDueTime === undefined) throw new Error("No scheduled jobs were recorded.");
          const deadline = lastDueTime + MAX_DELIVERY_LATENESS_MS;

          while (Date.now() <= deadline) {
            const rows = await prisma.emailJob.findMany({
              where: { userId, batchId },
              orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
              select: { id: true, scheduledAt: true, status: true, attempts: true, sentAt: true }
            });
            if (rows.some((row) => row.status === EmailJobStatus.FAILED)) {
              throw new Error("At least one smoke-test email job entered FAILED state.");
            }
            if (rows.length === RECIPIENT_COUNT && rows.every((row) => row.status === EmailJobStatus.SENT)) {
              scheduledRows = rows;
              break;
            }
            await sleep(1000);
          }

          if (scheduledRows.length !== RECIPIENT_COUNT ||
              scheduledRows.some((row) => row.status !== EmailJobStatus.SENT)) {
            throw new Error("Not all five jobs reached SENT before the delivery deadline.");
          }

          for (const row of scheduledRows) {
            if (!row.sentAt) throw new Error(`EmailJob ${row.id} has no sentAt timestamp.`);
            if (row.sentAt.getTime() < row.scheduledAt.getTime()) {
              throw new Error(`EmailJob ${row.id} was sent before its scheduled time.`);
            }
            if (row.sentAt.getTime() > row.scheduledAt.getTime() + MAX_DELIVERY_LATENESS_MS) {
              throw new Error(`EmailJob ${row.id} was sent more than 60 seconds late.`);
            }
            if (row.attempts !== 1) {
              throw new Error(`EmailJob ${row.id} has ${row.attempts} send attempts instead of one.`);
            }
            const queueJob = await emailQueue.getJob(row.id);
            if (!queueJob || await queueJob.getState() !== "completed") {
              throw new Error(`BullMQ job ${row.id} did not complete.`);
            }
          }
        }
      );
    } else {
      console.error("FAIL 2. Restart recovery and delivery (not run because check 1 failed)");
    }

    if (restartCheckPassed) {
      duplicateCheckPassed = await runCheck(
        "3. Re-enqueueing each completed jobId does not send a second time",
        async () => {
          const originalSentAt = new Map(
            scheduledRows.map((row) => [row.id, row.sentAt?.getTime()])
          );
          for (const row of scheduledRows) {
            await enqueueEmail(row.id, row.scheduledAt);
          }

          const deadline = Date.now() + 30_000;
          while (Date.now() <= deadline) {
            const rows = await prisma.emailJob.findMany({
              where: { userId, batchId },
              select: { id: true, status: true, attempts: true, sentAt: true }
            });
            const queueStates = await Promise.all(
              rows.map(async (row) => (await emailQueue.getJob(row.id))?.getState())
            );
            if (
              rows.length === RECIPIENT_COUNT &&
              rows.every((row) => row.status === EmailJobStatus.SENT && row.attempts === 1) &&
              queueStates.every((state) => state === "completed")
            ) {
              for (const row of rows) {
                if (row.sentAt?.getTime() !== originalSentAt.get(row.id)) {
                  throw new Error(`EmailJob ${row.id} was delivered again after re-enqueue.`);
                }
              }
              return;
            }
            await sleep(250);
          }
          throw new Error("Re-enqueued jobs did not return to completed state in 30 seconds.");
        }
      );
    } else {
      console.error("FAIL 3. Duplicate enqueue protection (not run because check 2 failed)");
    }
  } finally {
    client.close();
    await Promise.allSettled([
      emailQueue.close(),
      redis.quit(),
      prisma.$disconnect()
    ]);
  }

  if (!scheduleCheckPassed || !restartCheckPassed || !duplicateCheckPassed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`FAIL smoke test setup: ${message}`);
  console.error("FAIL 1. Five scheduled rows and five delayed BullMQ jobs (not run)");
  console.error("FAIL 2. Restart recovery and delivery (not run)");
  console.error("FAIL 3. Duplicate enqueue protection (not run)");
  process.exitCode = 1;
});
