import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config/env.js";
import { EmailJobStatus } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import {
  listAllEmailJobs,
  listEmailJobs,
  scheduleEmail,
  scheduleEmailBatch
} from "../services/schedulingService.js";
import { ensureSenders } from "../services/senderService.js";
import {
  searchEmailJobs,
  searchScheduledEmailJobs
} from "../services/integrationService.js";

const scheduleEmailSchema = z.object({
  recipient: z.string().email(),
  subject: z.string().trim().min(1).max(config.EMAIL_MAX_SUBJECT_LENGTH),
  body: z.string().min(1).max(config.EMAIL_MAX_BODY_LENGTH),
  scheduledAt: z.string().datetime({ offset: true })
});

const scheduleBatchSchema = z.object({
  subject: z.string().trim().min(1).max(config.EMAIL_MAX_SUBJECT_LENGTH),
  body: z.string().min(1).max(config.EMAIL_MAX_BODY_LENGTH),
  recipients: z.array(z.string().trim().email()).min(1).max(config.EMAIL_MAX_RECIPIENTS_PER_BATCH),
  startTime: z.string().datetime({ offset: true }),
  delayBetweenMs: z.number().int().nonnegative(),
  hourlyLimit: z.number().int().positive().optional()
}).superRefine((input, context) => {
  const normalizedRecipients = input.recipients.map((recipient) => recipient.toLowerCase());
  if (new Set(normalizedRecipients).size !== normalizedRecipients.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recipients"],
      message: "Recipients must be unique within a batch."
    });
  }

  const finalScheduledAt =
    Date.parse(input.startTime) + (input.recipients.length - 1) * input.delayBetweenMs;
  if (!Number.isFinite(finalScheduledAt) || Math.abs(finalScheduledAt) > 8_640_000_000_000_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delayBetweenMs"],
      message: "The final scheduled time is outside the supported date range."
    });
  }
});

const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20)
});

const emailSearchSchema = z.object({
  q: z.string().max(200).default(""),
  status: z.nativeEnum(EmailJobStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20)
});

export async function createScheduledBatch(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const senderCount = await prisma.sender.count({ where: { userId } });
    if (senderCount === 0) {
      await ensureSenders(userId);
    }

    const parsed = scheduleBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid email batch",
        details: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const batch = await scheduleEmailBatch({
      ...parsed.data,
      userId,
      startTime: new Date(parsed.data.startTime)
    });
    response.status(201).json({ data: batch.emails, batchId: batch.batchId });
  } catch (error) {
    next(error);
  }
}

export function getEmailLimits(
  _request: Request,
  response: Response
): void {
  response.json({
    data: {
      maxEmailsPerHourPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
      maxRecipientsPerBatch: config.EMAIL_MAX_RECIPIENTS_PER_BATCH
    }
  });
}

export async function createEmailJob(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const senderCount = await prisma.sender.count({ where: { userId } });
    if (senderCount === 0) {
      await ensureSenders(userId);
    }

    const parsed = scheduleEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid email schedule",
        details: parsed.error.flatten().fieldErrors
      });
      return;
    }

    const job = await scheduleEmail({
      ...parsed.data,
      userId,
      scheduledAt: new Date(parsed.data.scheduledAt)
    });
    response.status(201).json({ data: job });
  } catch (error) {
    next(error);
  }
}

export async function getEmailJobs(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    response.json({ data: await listAllEmailJobs(userId) });
  } catch (error) {
    next(error);
  }
}

async function getJobsByStatus(
  request: Request,
  response: Response,
  next: NextFunction,
  status: "SCHEDULED" | "SENT"
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = paginationSchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({
      error: "Invalid pagination parameters",
      details: parsed.error.flatten().fieldErrors
    });
    return;
  }

  try {
    const result = await listEmailJobs(userId, status, parsed.data.page, parsed.data.pageSize);
    response.json(result);
  } catch (error) {
    next(error);
  }
}

export function getScheduledEmailJobs(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  return getJobsByStatus(request, response, next, "SCHEDULED");
}

export function getSentEmailJobs(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  return getJobsByStatus(request, response, next, "SENT");
}

export async function searchEmails(
  request: Request,
  response: Response
): Promise<void> {
  const parsed = emailSearchSchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({
      error: "Invalid search parameters",
      details: parsed.error.flatten().fieldErrors
    });
    return;
  }

  if (!request.user) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const result = parsed.data.status === EmailJobStatus.SCHEDULED
      ? await searchScheduledEmailJobs(
          request.user.id,
          parsed.data.q,
          parsed.data.page,
          parsed.data.pageSize
        )
      : await searchEmailJobs(
          request.user.id,
          parsed.data.q,
          parsed.data.status,
          parsed.data.page,
          parsed.data.pageSize,
          parsed.data.status === EmailJobStatus.SENT
            ? [EmailJobStatus.SENT, EmailJobStatus.FAILED]
            : undefined
        );
    response.json(result);
  } catch {
    response.status(503).json({ error: "Email search is temporarily unavailable" });
  }
}
