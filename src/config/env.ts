import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const configDirectory = dirname(fileURLToPath(import.meta.url));
const backendEnvFilePath = resolve(configDirectory, "../../.env");
const rootEnvFilePath = resolve(configDirectory, "../../../.env");
const envFilePath = existsSync(backendEnvFilePath)
  ? backendEnvFilePath
  : existsSync(rootEnvFilePath)
    ? rootEnvFilePath
    : undefined;

if (envFilePath) {
  const result = dotenv.config({ path: envFilePath });
  if (result.error) {
    throw new Error(`Could not load environment file ${envFilePath}.`, { cause: result.error });
  }
  if (process.env.NODE_ENV === "development") {
    console.info(`Loaded environment from ${envFilePath}.`);
  }
}

const requiredVariables = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JWT_SECRET",
  "BULL_BOARD_PASSWORD"
] as const;
const missingVariables = requiredVariables.filter((name) => !process.env[name]?.trim());

if (missingVariables.length > 0) {
  throw new Error(
    `Missing required environment variable${missingVariables.length === 1 ? "" : "s"}: ${missingVariables.join(", ")}. Set them in backend/.env, the project-root .env, or the process environment.`
  );
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  ELASTICSEARCH_URL: z.string().url(),
  ELASTICSEARCH_INDEX: z.string().min(1).default("emails"),
  SMTP_HOST: z.string().min(1).default("smtp.ethereal.email"),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().email().default("scheduler@example.com"),
  SLACK_WEBHOOK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().int().nonnegative().default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().positive().default(100),
  JWT_SECRET: z.string().min(32),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALLBACK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_CALLBACK_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  SLACK_SIGNING_SECRET: z.string().default(""),
  JOB_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JOB_RETRY_BACKOFF_DELAY_MS: z.coerce.number().int().positive().default(5000),
  JOB_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  EMAIL_MAX_SUBJECT_LENGTH: z.coerce.number().int().positive().default(998),
  EMAIL_MAX_BODY_LENGTH: z.coerce.number().int().positive().default(100_000),
  EMAIL_MAX_RECIPIENTS_PER_BATCH: z.coerce.number().int().positive().default(1000),
  API_JSON_LIMIT_BYTES: z.coerce.number().int().positive().default(262_144),
  PROCESSING_STALE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  BULL_BOARD_USERNAME: z.string().min(1),
  BULL_BOARD_PASSWORD: z.string().min(16)
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment configuration:", parsedEnv.error.flatten().fieldErrors);
  throw new Error("Environment configuration is invalid");
}

export const config = parsedEnv.data;
