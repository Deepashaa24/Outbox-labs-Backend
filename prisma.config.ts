import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

const configDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const backendEnvFilePath = resolve(configDirectory, ".env");
const rootEnvFilePath = resolve(configDirectory, "../.env");
const hasRuntimeEnv = Boolean(
  process.env.DATABASE_URL ||
  process.env.REDIS_URL ||
  process.env.ELASTICSEARCH_URL ||
  process.env.JWT_SECRET ||
  process.env.GOOGLE_CLIENT_ID ||
  process.env.GOOGLE_CLIENT_SECRET
);
const envFilePath = !hasRuntimeEnv && !process.env.NODE_ENV?.startsWith("prod")
  ? (existsSync(backendEnvFilePath)
      ? backendEnvFilePath
      : existsSync(rootEnvFilePath)
        ? rootEnvFilePath
        : undefined)
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

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  }
});
