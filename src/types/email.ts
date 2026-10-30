import type { EmailJobStatus } from "@prisma/client";

export interface EmailJobResponse {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  scheduledAt: string;
  status: EmailJobStatus;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface ApiResponse<T> {
  data: T;
}
