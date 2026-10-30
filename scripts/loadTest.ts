import { z } from "zod";
import jwt from "jsonwebtoken";
import { config } from "../src/config/env.js";

const apiUrl = z.string().url().default("http://localhost:4000").parse(
  process.env.API_URL
);
const recipientCount = 1000;
const userId = z.string().uuid().parse(process.env.LOAD_TEST_USER_ID);
const accessToken = jwt.sign(
  {},
  config.JWT_SECRET,
  { subject: userId, expiresIn: config.JWT_TTL_SECONDS }
);

interface ScheduleResponse {
  data?: Array<{ id: string; toEmail: string; scheduledAt: string }>;
  batchId?: string;
  error?: string;
}

async function main(): Promise<void> {
  const response = await fetch(`${apiUrl}/api/emails/schedule`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      subject: "Email scheduler rate-limit load test",
      body: "This message is captured by the configured Ethereal test sender.",
      recipients: Array.from(
        { length: recipientCount },
        (_value, index) => `load-test-${String(index + 1).padStart(4, "0")}@example.test`
      ),
      startTime: new Date().toISOString(),
      delayBetweenMs: 0,
      hourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER
    })
  });

  const result = await response.json() as ScheduleResponse;
  if (!response.ok) {
    throw new Error(result.error ?? `Batch scheduling failed with HTTP ${response.status}`);
  }
  if (!result.batchId || result.data?.length !== recipientCount) {
    throw new Error("Schedule API returned an unexpected batch response");
  }

  const inspectionResponse = await fetch(
    `${apiUrl}/api/emails/scheduled?page=1&pageSize=100`,
    { headers: { authorization: `Bearer ${accessToken}` } }
  );
  if (!inspectionResponse.ok) {
    throw new Error(`Could not inspect scheduled jobs (HTTP ${inspectionResponse.status})`);
  }
  const inspection = await inspectionResponse.json() as {
    pagination?: { total?: number };
  };

  console.info(`Scheduled ${result.data.length} emails in batch ${result.batchId}.`);
  console.info(
    `Per-sender hourly cap: ${config.MAX_EMAILS_PER_HOUR_PER_SENDER}. ` +
    "Excess jobs remain queued and are delayed into the next UTC hour."
  );
  console.info(`Authenticated scheduled-job listing reports ${inspection.pagination?.total ?? 0} job(s) for ${userId}.`);
}

main().catch((error: unknown) => {
  console.error("Email scheduler load test failed.", error);
  process.exitCode = 1;
});
