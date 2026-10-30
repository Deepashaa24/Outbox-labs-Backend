import type { Server } from "node:http";
import { app } from "./app.js";
import { config } from "./config/env.js";
import { elasticsearch } from "./config/elasticsearch.js";
import { redis } from "./config/redis.js";
import { prisma } from "./db/prisma.js";
import { emailQueue } from "./queues/emailQueue.js";
import { reconcileScheduledEmails } from "./services/schedulingService.js";
import { assertDatabaseReady } from "./services/startupChecks.js";
import { ensureEmailsIndex } from "./services/integrationService.js";

let server: Server | undefined;
let shuttingDown = false;

function isPrismaConnectionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errorCode" in error &&
    error.errorCode === "P1001"
  );
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down API.`);

  const errors: unknown[] = [];
  if (server?.listening) {
    try {
      await new Promise<void>((resolveClose, rejectClose) => {
        server?.close((error) => error ? rejectClose(error) : resolveClose());
      });
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
    console.error("API shutdown encountered errors.", errors);
    process.exitCode = 1;
  } else {
    process.exitCode = exitCode;
  }
}

async function start(): Promise<void> {
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await prisma.$connect();
  } catch (error) {
    if (isPrismaConnectionError(error)) {
      console.error(
        "Prisma could not reach PostgreSQL (P1001). In Render, set DATABASE_URL to the PostgreSQL database's Internal Database URL and ensure the database is available in the same region/network. Do not use localhost for a separate Render service."
      );
    }
    throw error;
  }
  try {
    await assertDatabaseReady();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Database schema check failed.",
      "\nRun: npm run db:setup"
    );
    await shutdown("startup failure", 1);
    return;
  }

  await redis.ping();
  if (shuttingDown) return;
  void ensureEmailsIndex().catch((error: unknown) => {
    console.warn("Could not ensure the Elasticsearch email index.", error);
  });
  await reconcileScheduledEmails();

  server = app.listen(config.PORT, () => {
    console.info(`Email scheduler API listening on port ${config.PORT}.`);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${config.PORT} is already in use. Run \`npm run dev:clean\` or stop the other process`
      );
    } else {
      console.error("HTTP server failed.", error);
    }
    void shutdown("server error", 1);
  });
}

start().catch(async (error: unknown) => {
  console.error("Application startup failed.", error);
  await shutdown("startup failure", 1);
});
