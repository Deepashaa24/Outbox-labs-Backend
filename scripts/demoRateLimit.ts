import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../src/config/env.js";
import { prisma } from "../src/db/prisma.js";
import { redis } from "../src/config/redis.js";

const RECIPIENT_COUNT = 20;
const BATCH_HOURLY_LIMIT = 5;
const DELAY_BETWEEN_MS = 1000;
const START_DELAY_MS = 1000;
const MAX_WAIT_MS = 60_000;
const userId = z.string().uuid().parse(process.env.LOAD_TEST_USER_ID);
const apiUrl = z.string().url().default(`http://localhost:${config.PORT}`).parse(
  process.env.API_URL
).replace(/\/+$/, "");

function getUtcHourKey(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCHours()).padStart(2, "0")
  ].join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function main(): Promise<void> {
  const token = jwt.sign(
    {},
    config.JWT_SECRET,
    { subject: userId, expiresIn: config.JWT_TTL_SECONDS }
  );
  const batchId = randomUUID();
  const startTime = new Date(Date.now() + START_DELAY_MS);
  const hourEndsAt = Date.UTC(
    startTime.getUTCFullYear(),
    startTime.getUTCMonth(),
    startTime.getUTCDate(),
    startTime.getUTCHours() + 1
  );
  if (hourEndsAt - startTime.getTime() < MAX_WAIT_MS + START_DELAY_MS + RECIPIENT_COUNT * DELAY_BETWEEN_MS) {
    throw new Error("Run the rate-limit demo with at least 90 seconds left in the current UTC hour.");
  }

  await prisma.$connect();
  try {
    await redis.ping();
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        senders: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, smtpHost: true }
        },
        slackConnection: { select: { webhookUrl: true } }
      }
    });
    if (!user) throw new Error(`No user found for LOAD_TEST_USER_ID ${userId}.`);
    if (user.senders.length === 0) throw new Error("The user needs at least one configured sender.");
    if (user.senders.some((sender) => sender.smtpHost !== "smtp.ethereal.email")) {
      throw new Error("This demo sends email jobs; use only Ethereal sender accounts.");
    }

    const hourKey = getUtcHourKey(startTime);
    const notifiedKeys = new Map(
      user.senders.map((sender) => [
        sender.id,
        `slack:rate-limit-notified:${sender.id}:${hourKey}`
      ])
    );
    const previouslyMarked = new Set<string>();
    for (const [senderId, key] of notifiedKeys) {
      if (await redis.get(key)) previouslyMarked.add(senderId);
    }

    const authHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };
    const meResponse = await fetch(`${apiUrl}/api/me`, { headers: authHeaders });
    if (!meResponse.ok) throw new Error(`API authentication failed with HTTP ${meResponse.status}.`);
    const meBody: unknown = await meResponse.json();
    if (!isRecord(meBody) || !isRecord(meBody.data) || meBody.data.id !== userId) {
      throw new Error("The API authenticated a different user than LOAD_TEST_USER_ID.");
    }

    const scheduleResponse = await fetch(`${apiUrl}/api/emails/schedule`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        subject: `Rate-limit demo ${batchId}`,
        body: "Ethereal-only per-batch hourly rate-limit demonstration.",
        recipients: Array.from(
          { length: RECIPIENT_COUNT },
          (_value, index) => `ratelimit-demo-${batchId}-${index + 1}@example.test`
        ),
        startTime: startTime.toISOString(),
        delayBetweenMs: DELAY_BETWEEN_MS,
        hourlyLimit: BATCH_HOURLY_LIMIT
      })
    });
    const scheduleBody: unknown = await scheduleResponse.json().catch(() => undefined);
    if (!scheduleResponse.ok) {
      const message = isRecord(scheduleBody) && typeof scheduleBody.error === "string"
        ? scheduleBody.error
        : `HTTP ${scheduleResponse.status}`;
      throw new Error(`Could not schedule rate-limit batch: ${message}`);
    }
    if (!isRecord(scheduleBody) || scheduleBody.batchId !== batchId) {
      throw new Error("Schedule API returned an unexpected batch ID.");
    }

    const batch = await prisma.emailJob.findMany({
      where: { userId, batchId },
      select: { id: true, senderId: true, scheduledAt: true, status: true }
    });
    if (batch.length !== RECIPIENT_COUNT) {
      throw new Error(`Expected ${RECIPIENT_COUNT} database rows, found ${batch.length}.`);
    }

    console.info(`Scheduled ${batch.length} Ethereal email jobs with hourlyLimit=${BATCH_HOURLY_LIMIT}.`);
    console.info(`Senders: ${new Set(batch.map((job) => job.senderId)).size}; interval: ${DELAY_BETWEEN_MS} ms.`);

    const deadline = Date.now() + MAX_WAIT_MS;
    let rows = batch;
    while (Date.now() <= deadline) {
      rows = await prisma.emailJob.findMany({
        where: { userId, batchId },
        select: { id: true, senderId: true, scheduledAt: true, status: true }
      });
      const finished = rows.length === RECIPIENT_COUNT && rows.every((job) =>
        job.status === "SENT" ||
        (job.status === "SCHEDULED" && job.scheduledAt.getTime() >= hourEndsAt)
      );
      if (finished) break;
      if (rows.some((job) => job.status === "FAILED")) break;
      await sleep(500);
    }

    const sent = rows.filter((job) => job.status === "SENT").length;
    const rescheduled = rows.filter((job) =>
      job.status === "SCHEDULED" && job.scheduledAt.getTime() >= hourEndsAt
    ).length;
    const failed = rows.filter((job) => job.status === "FAILED").length;
    console.info(`Sent: ${sent}`);
    console.info(`Rescheduled to the next UTC hour: ${rescheduled}`);
    console.info(`Failed or still pending: ${RECIPIENT_COUNT - sent - rescheduled}`);
    if (failed > 0) {
      console.error(`Failed jobs: ${failed}`);
    }

    const rateLimitedSenderIds = new Set(
      rows.filter((job) =>
        job.status === "SCHEDULED" && job.scheduledAt.getTime() >= hourEndsAt
      ).map((job) => job.senderId)
    );
    await sleep(1500);
    const newlyNotified: string[] = [];
    const alreadyMarked: string[] = [];
    for (const senderId of rateLimitedSenderIds) {
      const key = notifiedKeys.get(senderId);
      if (!key || await redis.get(key) !== "sent") continue;
      if (previouslyMarked.has(senderId)) alreadyMarked.push(senderId);
      else newlyNotified.push(senderId);
    }

    if (!user.slackConnection?.webhookUrl) {
      console.info("Slack rate-limit notification fired: No (user has no Slack connection).");
    } else if (newlyNotified.length > 0) {
      console.info(
        `Slack rate-limit notification fired: Yes (${newlyNotified.length} sender(s); one deduplicated notification per sender/hour).`
      );
    } else if (alreadyMarked.length > 0) {
      console.info(
        `Slack rate-limit notification fired: No new notification (${alreadyMarked.length} sender(s) already had a deduplication marker this UTC hour).`
      );
    } else {
      console.info("Slack rate-limit notification fired: No (no new per-sender notification key was recorded).");
    }

    if (sent + rescheduled !== RECIPIENT_COUNT) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  }
}

main().catch((error: unknown) => {
  console.error("Rate-limit demo failed.", error);
  process.exitCode = 1;
});
