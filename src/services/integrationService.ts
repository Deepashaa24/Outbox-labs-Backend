import { EmailJobStatus, type EmailJob } from "@prisma/client";
import { elasticsearch } from "../config/elasticsearch.js";
import { prisma } from "../db/prisma.js";

const EMAILS_INDEX = "emails";

export interface EmailSearchDocument {
  id: string;
  userId: string;
  senderId: string;
  toEmail: string;
  subject: string;
  body: string;
  status: EmailJobStatus;
  scheduledAt: string;
  sentAt: string | null;
  batchId: string | null;
  attempts: number;
  searchVersion: number;
  error: string | null;
  createdAt: string;
}

export interface EmailSearchResult extends EmailSearchDocument {
  id: string;
}

function toSearchDocument(job: EmailJob): EmailSearchDocument {
  return {
    id: job.id,
    userId: job.userId,
    senderId: job.senderId,
    toEmail: job.toEmail,
    subject: job.subject,
    body: job.body,
    status: job.status,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt?.toISOString() ?? null,
    batchId: job.batchId,
    attempts: job.attempts,
    searchVersion: job.searchVersion,
    error: job.error,
    createdAt: job.createdAt.toISOString()
  };
}

let emailsIndexPromise: Promise<void> | undefined;

async function createEmailsIndexIfMissing(): Promise<void> {
  try {
    const exists = await elasticsearch.indices.exists({ index: EMAILS_INDEX });
    if (exists) return;

    await elasticsearch.indices.create({
      index: EMAILS_INDEX,
      mappings: {
        properties: {
          id: { type: "keyword" },
          userId: { type: "keyword" },
          senderId: { type: "keyword" },
          toEmail: { type: "text", fields: { keyword: { type: "keyword" } } },
          subject: { type: "text", fields: { keyword: { type: "keyword" } } },
          body: { type: "text" },
          status: { type: "keyword" },
          scheduledAt: { type: "date" },
          sentAt: { type: "date" },
          batchId: { type: "keyword" },
          attempts: { type: "integer" },
          searchVersion: { type: "long" },
          error: { type: "text" },
          createdAt: { type: "date" }
        }
      }
    });
  } catch (error) {
    emailsIndexPromise = undefined;
    console.error("Elasticsearch emails index initialization failed.", error);
  }
}

export function ensureEmailsIndex(): Promise<void> {
  emailsIndexPromise ??= createEmailsIndexIfMissing();
  return emailsIndexPromise;
}

export async function indexEmailJob(job: EmailJob): Promise<void> {
  try {
    await ensureEmailsIndex();
    await elasticsearch.index({
      index: EMAILS_INDEX,
      id: job.id,
      version: job.searchVersion,
      version_type: "external",
      document: toSearchDocument(job)
    });
  } catch (error) {
    console.error(`Elasticsearch indexing failed for email job ${job.id}.`, error);
  }
}

export async function updateEmailSearchDocument(job: EmailJob): Promise<void> {
  try {
    await ensureEmailsIndex();
    await elasticsearch.index({
      index: EMAILS_INDEX,
      id: job.id,
      version: job.searchVersion,
      version_type: "external",
      document: toSearchDocument(job)
    });
  } catch (error) {
    console.error(`Elasticsearch status update failed for email job ${job.id}.`, error);
  }
}

export async function searchEmailJobs(
  userId: string,
  query: string,
  status: EmailJobStatus | undefined,
  page: number,
  pageSize: number,
  statuses?: EmailJobStatus[]
): Promise<{
  data: EmailSearchResult[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  try {
    const result = await elasticsearch.search<EmailSearchDocument>({
      index: EMAILS_INDEX,
      from: (page - 1) * pageSize,
      size: pageSize,
      query: {
        bool: {
          must: query.trim()
            ? [{ multi_match: { query: query.trim(), fields: ["toEmail", "subject", "body"] } }]
            : [{ match_all: {} }],
          filter: [
            { term: { userId } },
            ...(statuses
              ? [{ terms: { status: statuses } }]
              : status ? [{ term: { status } }] : [])
          ]
        }
      },
      sort: status === "SENT"
        ? [
            { sentAt: { order: "desc", missing: "_last" } },
            { scheduledAt: { order: "desc" } }
          ]
        : [{ scheduledAt: { order: "asc" } }]
    });

    const data = result.hits.hits.flatMap((hit) =>
      hit._source ? [{ ...hit._source, id: hit._id ?? hit._source.id }] : []
    );
    const total = typeof result.hits.total === "number"
      ? result.hits.total
      : result.hits.total?.value ?? 0;
    return {
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  } catch (error) {
    console.error("Elasticsearch email search failed.", error);
    throw new Error("Email search is temporarily unavailable");
  }
}

export async function searchScheduledEmailJobs(
  userId: string,
  query: string,
  page: number,
  pageSize: number
): Promise<{
  data: EmailSearchResult[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}> {
  if (!query.trim()) {
    const where = {
      userId,
      status: { in: [EmailJobStatus.SCHEDULED, EmailJobStatus.PROCESSING] }
    };
    const [jobs, total] = await prisma.$transaction([
      prisma.emailJob.findMany({
        where,
        orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.emailJob.count({ where })
    ]);

    return {
      data: jobs.map((job) => ({
        ...toSearchDocument(job),
        id: job.id
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    };
  }

  return searchEmailJobs(
    userId,
    query,
    EmailJobStatus.SCHEDULED,
    page,
    pageSize,
    [EmailJobStatus.SCHEDULED, EmailJobStatus.PROCESSING]
  );
}
