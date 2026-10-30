import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { prisma } from "../src/db/prisma.js";
import { ensureSenders } from "../src/services/senderService.js";

const seedDirectory = dirname(fileURLToPath(import.meta.url));
const backendEnvFilePath = resolve(seedDirectory, "../.env");
const rootEnvFilePath = resolve(seedDirectory, "../../.env");
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

const databaseUrl = z.string().min(1).safeParse(process.env.DATABASE_URL);
if (!databaseUrl.success) {
  throw new Error(
    `DATABASE_URL is required to seed the database. Add it to backend/.env, the project-root .env, or export it in your shell.`
  );
}

const seedUserEmail = "demo@reachinbox.local";

async function seed(): Promise<void> {
  const user = await prisma.user.upsert({
    where: { email: seedUserEmail },
    update: { name: "ReachInbox Demo" },
    create: { email: seedUserEmail, name: "ReachInbox Demo" }
  });

  await ensureSenders(user.id);

  const senderCount = await prisma.sender.count({ where: { userId: user.id } });
  if (senderCount < 1) {
    throw new Error("The demo user has no senders after provisioning.");
  }
  console.info(`Seeded demo user with ${senderCount} sender(s).`);
}

seed()
  .catch((error: unknown) => {
    console.error("Database seed failed.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
