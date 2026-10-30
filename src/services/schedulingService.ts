import { EmailJobStatus } from "@prisma/client";
import type { EmailJob } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { emailQueue } from "../queues/emailQueue.js";
import { prisma } from "../db/prisma.js";
import type { EmailJobResponse } from "../types/email.js";
import { indexEmailJob, updateEmailSearchDocument } from "./integrationService.js";

export interface ScheduleEmailInput {
  userId: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: Date;
  batchId?: string;
}

export interface ScheduleEmailBatchInput {
  userId: string;
  subject: string;
  body: string;
  recipients: string[];
  startTime: Date;
  delayBetweenMs: number;
  hourlyLimit?: number;
}

export interface PaginatedEmailJobs {
  data: EmailJobResponse[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

function toEmailJobResponse(job: EmailJob): EmailJobResponse {
  return {
    id: job.id,
    toEmail: job.toEmail,
    subject: job.subject,
    body: job.body,
    scheduledAt: job.scheduledAt.toISOString(),
    status: job.status,
    sentAt: job.sentAt?.toISOString() ?? null,
    error: job.error,
    createdAt: job.createdAt.toISOString()
  };
}

export async function scheduleEmail(input: ScheduleEmailInput): Promise<EmailJobResponse> {
  const sender = await prisma.sender.findFirst({
    where: { userId: input.userId },
    orderBy: { createdAt: "asc" }
  });

  if (!sender) {
    throw new Error("No SMTP sender is configured. Run the database seed script first.");
  }

  const job = await prisma.emailJob.create({
    data: {
      toEmail: input.recipient,
      subject: input.subject,
      body: input.body,
      scheduledAt: input.scheduledAt,
      batchId: input.batchId,
      hourlyLimit: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      senderId: sender.id,
      userId: input.userId
    }
  });
  void indexEmailJob(job);

  try {
    await enqueueEmail(job.id, job.scheduledAt);
  } catch (error) {
    console.error(`Queueing email job ${job.id} failed; it will be reconciled on startup.`, error);
    throw error;
  }

  return toEmailJobResponse(job);
}

export async function scheduleEmailBatch(
  input: ScheduleEmailBatchInput
): Promise<{ batchId: string; emails: EmailJobResponse[] }> {
  const batchId = randomUUID();
  const jobs = await prisma.$transaction(async (transaction) => {
    const senders = await transaction.sender.findMany({
      where: { userId: input.userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });

    if (senders.length === 0) {
      throw new Error("No SMTP senders are configured. Run the database seed script first.");
    }

    const rows = input.recipients.map((toEmail, index) => {
      const sender = senders[index % senders.length];
      if (!sender) {
        throw new Error("Could not assign an SMTP sender to an email job.");
      }

      return {
        id: randomUUID(),
        toEmail,
        subject: input.subject,
        body: input.body,
        scheduledAt: new Date(input.startTime.getTime() + index * input.delayBetweenMs),
        status: EmailJobStatus.SCHEDULED,
        batchId,
        hourlyLimit: input.hourlyLimit,
        senderId: sender.id,
        userId: input.userId
      };
    });

    return transaction.emailJob.createManyAndReturn({ data: rows });
  });
  for (const job of jobs) void indexEmailJob(job);

  try {
    await emailQueue.addBulk(jobs.map((job) => ({
      name: "deliver",
      data: {
        emailJobId: job.id,
        batchId,
        ...(input.hourlyLimit === undefined ? {} : { hourlyLimit: input.hourlyLimit })
      },
      opts: {
        jobId: job.id,
        delay: Math.max(0, job.scheduledAt.getTime() - Date.now())
      }
    })));
  } catch (error) {
    console.error(`Queueing email batch ${batchId} failed; it will be reconciled on startup.`, error);
    throw error;
  }

  return {
    batchId,
    emails: jobs.map((job) => toEmailJobResponse({
      ...job,
      sentAt: null,
      attempts: 0,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date()
    }))
  };
}

export async function listEmailJobs(
  userId: string,
  status: EmailJobStatus,
  page: number,
  pageSize: number
): Promise<PaginatedEmailJobs> {
  const where = {
    userId,
    status: status === EmailJobStatus.SENT
      ? { in: [EmailJobStatus.SENT, EmailJobStatus.FAILED] }
      : status
  };
  const [jobs, total] = await prisma.$transaction([
    prisma.emailJob.findMany({
      where,
      orderBy: status === EmailJobStatus.SENT
        ? [{ sentAt: "desc" }, { scheduledAt: "desc" }, { id: "asc" }]
        : [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.emailJob.count({ where })
  ]);
  return {
    data: jobs.map(toEmailJobResponse),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    }
  };
}

export async function listAllEmailJobs(userId: string): Promise<EmailJobResponse[]> {
  const jobs = await prisma.emailJob.findMany({
    where: { userId },
    orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }]
  });
  return jobs.map(toEmailJobResponse);
}

export async function enqueueEmail(emailJobId: string, scheduledAt: Date): Promise<void> {
  const existing = await emailQueue.getJob(emailJobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "failed" && state !== "completed") return;
    await existing.remove();
  }

  await emailQueue.add(
    "deliver",
    { emailJobId },
    {
      jobId: emailJobId,
      delay: Math.max(0, scheduledAt.getTime() - Date.now())
    }
  );
}

export async function reconcileScheduledEmails(): Promise<void> {
  const jobs = await prisma.emailJob.findMany({
    where: { status: EmailJobStatus.SCHEDULED },
    select: { id: true, scheduledAt: true, batchId: true, hourlyLimit: true }
  });

  for (const job of jobs) {
    const existing = await emailQueue.getJob(job.id);
    if (existing) {
      const state = await existing.getState();
      if (state !== "failed" && state !== "completed") continue;
      await existing.remove();
    }
    await emailQueue.add(
      "deliver",
      {
        emailJobId: job.id,
        batchId: job.batchId,
        hourlyLimit: job.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR_PER_SENDER
      },
      {
        jobId: job.id,
        delay: Math.max(0, job.scheduledAt.getTime() - Date.now())
      }
    );
  }

}

export async function recoverStuckProcessingJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - config.PROCESSING_STALE_TIMEOUT_MS);
  const staleJobs = await prisma.emailJob.findMany({
    where: {
      status: EmailJobStatus.PROCESSING,
      updatedAt: { lt: staleBefore }
    },
    select: { id: true }
  });
  const recovered = await prisma.emailJob.updateMany({
    where: {
      status: EmailJobStatus.PROCESSING,
      updatedAt: { lt: staleBefore }
    },
    data: {
      status: EmailJobStatus.FAILED,
      error: "Worker stopped during delivery; SMTP outcome is unknown.",
      searchVersion: { increment: 1 }
    }
  });

  if (recovered.count > 0) {
    const failedJobs = await prisma.emailJob.findMany({
      where: {
        id: { in: staleJobs.map((job) => job.id) },
        status: EmailJobStatus.FAILED
      }
    });
    for (const job of failedJobs) void updateEmailSearchDocument(job);
  }

  if (recovered.count > 0) {
    console.warn(
      `Marked ${recovered.count} stale PROCESSING email job(s) FAILED for manual review; SMTP delivery outcome may be unknown.`
    );
  }
}
