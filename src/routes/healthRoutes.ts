import { Router } from "express";
import { elasticsearch } from "../config/elasticsearch.js";
import { redis } from "../config/redis.js";
import { prisma } from "../db/prisma.js";
import { emailQueue } from "../queues/emailQueue.js";

type ProbeStatus = "ok" | "down";
type QueueCounts = Pick<
  Awaited<ReturnType<typeof emailQueue.getJobCounts>>,
  "waiting" | "delayed" | "active" | "failed"
>;
type QueueHealth =
  | { status: "ok"; counts: QueueCounts }
  | { status: "down"; counts: null };

async function probe(name: string, check: () => Promise<unknown>): Promise<ProbeStatus> {
  try {
    await check();
    return "ok";
  } catch (error) {
    console.warn(`Health check failed for ${name}.`, error);
    return "down";
  }
}

async function checkQueue(): Promise<QueueHealth> {
  try {
    const counts = await emailQueue.getJobCounts("waiting", "delayed", "active", "failed");
    return {
      status: "ok",
      counts: {
        waiting: counts.waiting ?? 0,
        delayed: counts.delayed ?? 0,
        active: counts.active ?? 0,
        failed: counts.failed ?? 0
      }
    };
  } catch (error) {
    console.warn("Health check failed for BullMQ.", error);
    return { status: "down", counts: null };
  }
}

export const healthRoutes = Router();

healthRoutes.get("/", async (_request, response) => {
  const [postgres, redisStatus, elasticsearchStatus, queue] = await Promise.all([
    probe("PostgreSQL", () => prisma.$queryRaw`SELECT 1`),
    probe("Redis", async () => {
      if ((await redis.ping()) !== "PONG") throw new Error("Redis ping failed.");
    }),
    probe("Elasticsearch", async () => {
      if (!(await elasticsearch.ping())) throw new Error("Elasticsearch ping failed.");
    }),
    checkQueue()
  ]);

  const unhealthy = postgres === "down" || redisStatus === "down" || queue.status === "down";
  const status = unhealthy
    ? "unhealthy"
    : elasticsearchStatus === "down"
      ? "degraded"
      : "ok";

  response.status(unhealthy ? 503 : 200).json({
    status,
    services: {
      postgres,
      redis: redisStatus,
      elasticsearch: elasticsearchStatus === "ok" ? "ok" : "degraded",
      queue
    }
  });
});
