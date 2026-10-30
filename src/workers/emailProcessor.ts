import { EmailJobStatus } from "@prisma/client";
import { DelayedError, type Job } from "bullmq";
import { config } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import type { EmailQueuePayload } from "../queues/emailQueue.js";
import { sendEmail } from "../services/emailService.js";
import {
  updateEmailSearchDocument
} from "../services/integrationService.js";
import { notifySlack, notifySlackRateLimit } from "../services/slackService.js";
import { checkEmailRateLimit, type RateLimitResult } from "../services/rateLimitService.js";

export interface EmailProcessorDependencies {
  sendEmail: typeof sendEmail;
  updateSearchDocument: typeof updateEmailSearchDocument;
  notifySent: (userId: string, message: string) => Promise<void>;
  notifyRateLimit: typeof notifySlackRateLimit;
  checkRateLimit: typeof checkEmailRateLimit;
}

const productionDependencies: EmailProcessorDependencies = {
  sendEmail,
  updateSearchDocument: updateEmailSearchDocument,
  notifySent: notifySlack,
  notifyRateLimit: notifySlackRateLimit,
  checkRateLimit: checkEmailRateLimit
};

function isRetryableSmtpRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("responseCode" in error)) return false;
  const { responseCode } = error;
  return typeof responseCode === "number" && responseCode >= 400 && responseCode < 500;
}

export function createEmailProcessor(
  overrides: Partial<EmailProcessorDependencies> = {}
): (job: Job<EmailQueuePayload>, token?: string) => Promise<void> {
  const dependencies = { ...productionDependencies, ...overrides };

  async function releaseForRetry(emailJobId: string): Promise<void> {
    const released = await prisma.emailJob.updateMany({
      where: { id: emailJobId, status: EmailJobStatus.PROCESSING },
      data: {
        status: EmailJobStatus.SCHEDULED,
        searchVersion: { increment: 1 }
      }
    });
    if (released.count === 1) {
      const emailJob = await prisma.emailJob.findUnique({ where: { id: emailJobId } });
      if (emailJob) void dependencies.updateSearchDocument(emailJob);
    }
  }

  return async function processEmailJob(
    job: Job<EmailQueuePayload>,
    token?: string
  ): Promise<void> {
    const claimed = await prisma.emailJob.updateMany({
      where: { id: job.data.emailJobId, status: EmailJobStatus.SCHEDULED },
      data: {
        status: EmailJobStatus.PROCESSING,
        error: null,
        searchVersion: { increment: 1 }
      }
    });

    if (claimed.count === 0) return;

    const emailJob = await prisma.emailJob.findUnique({
      where: { id: job.data.emailJobId },
      include: { sender: true }
    }).catch(async (error: unknown) => {
      await releaseForRetry(job.data.emailJobId);
      throw error;
    });

    if (!emailJob) {
      throw new Error(`Claimed email job ${job.data.emailJobId} was not found`);
    }
    void dependencies.updateSearchDocument(emailJob);

    const rateLimit: RateLimitResult = await dependencies.checkRateLimit(
      emailJob.senderId,
      job.data.hourlyLimit ?? emailJob.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR_PER_SENDER
    ).catch(async (error: unknown) => {
      await releaseForRetry(emailJob.id);
      throw error;
    });

    if (!rateLimit.allowed) {
      const scheduledAtOffset =
        ((emailJob.scheduledAt.getTime() % 3_600_000) + 3_600_000) % 3_600_000;
      const delayedUntil = rateLimit.retryAt + scheduledAtOffset;
      const released = await prisma.emailJob.updateMany({
        where: { id: emailJob.id, status: EmailJobStatus.PROCESSING },
        data: {
          status: EmailJobStatus.SCHEDULED,
          scheduledAt: new Date(delayedUntil),
          searchVersion: { increment: 1 }
        }
      });

      if (released.count === 1) {
        const delayedJob = await prisma.emailJob.findUnique({ where: { id: emailJob.id } });
        if (delayedJob) void dependencies.updateSearchDocument(delayedJob);
        await job.moveToDelayed(delayedUntil, token);
        void dependencies.notifyRateLimit(emailJob.userId, emailJob.senderId);
        throw new DelayedError();
      }
      return;
    }

    const attempt = await prisma.emailJob.updateMany({
      where: { id: emailJob.id, status: EmailJobStatus.PROCESSING },
      data: {
        attempts: { increment: 1 },
        searchVersion: { increment: 1 }
      }
    }).catch(async (error: unknown) => {
      await releaseForRetry(emailJob.id);
      throw error;
    });

    if (attempt.count !== 1) return;

    try {
      const previewUrl = await dependencies.sendEmail(
        emailJob.sender,
        emailJob.toEmail,
        emailJob.subject,
        emailJob.body
      );

      const sentAt = new Date();
      const markedSent = await prisma.emailJob.updateMany({
        where: { id: emailJob.id, status: EmailJobStatus.PROCESSING },
        data: {
          status: EmailJobStatus.SENT,
          sentAt,
          error: null,
          searchVersion: { increment: 1 }
        }
      });

      if (markedSent.count !== 1) {
        throw new Error(`Email job ${emailJob.id} was delivered but could not be marked SENT`);
      }

      const sentJob = await prisma.emailJob.findUnique({ where: { id: emailJob.id } });
      if (sentJob) void dependencies.updateSearchDocument(sentJob);
      const notification = `Email sent to ${emailJob.toEmail} (job ${emailJob.id}).`;
      await dependencies.notifySent(
        emailJob.userId,
        previewUrl ? `${notification} Preview: ${previewUrl}` : notification
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email delivery error";
      const canRetry =
        isRetryableSmtpRejection(error) &&
        emailJob.attempts + 1 < config.JOB_RETRY_ATTEMPTS;

      if (!isRetryableSmtpRejection(error)) {
        console.error(
          `Email job ${emailJob.id} has an ambiguous SMTP outcome; it will not be retried automatically.`,
          error
        );
      }

      await prisma.emailJob.updateMany({
        where: { id: emailJob.id, status: EmailJobStatus.PROCESSING },
        data: {
          status: canRetry ? EmailJobStatus.SCHEDULED : EmailJobStatus.FAILED,
          error: message,
          searchVersion: { increment: 1 }
        }
      });
      const failedJob = await prisma.emailJob.findUnique({ where: { id: emailJob.id } });
      if (failedJob) void dependencies.updateSearchDocument(failedJob);

      if (canRetry) throw error;
    }
  };
}
