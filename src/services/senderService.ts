import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import nodemailer from "nodemailer";
import { z } from "zod";
import { prisma } from "../db/prisma.js";

const MAX_CREATE_ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;
const DEMO_USER_EMAIL = "demo@reachinbox.local";
const senderAccountsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../senders.local.json"
);
const senderAccountSchema = z.object({
  name: z.string().trim().min(1),
  user: z.string().trim().min(1),
  pass: z.string().min(1)
});
const senderAccountsSchema = z.array(senderAccountSchema);

async function readLocalSenderAccounts(): Promise<z.infer<typeof senderAccountsSchema>> {
  let contents: string;
  try {
    contents = await readFile(senderAccountsPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${senderAccountsPath}.`, { cause: error });
  }

  const parsed = senderAccountsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid sender accounts in ${senderAccountsPath}.`, {
      cause: parsed.error
    });
  }
  return parsed.data;
}

function isUniqueSenderError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function transferDemoSenders(userId: string, minCount: number): Promise<void> {
  const demoUser = await prisma.user.findUnique({
    where: { email: DEMO_USER_EMAIL },
    select: { id: true }
  });
  if (!demoUser || demoUser.id === userId) return;

  const currentCount = await prisma.sender.count({ where: { userId } });
  const demoSenders = await prisma.sender.findMany({
    where: { userId: demoUser.id },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });

  for (const sender of demoSenders) {
    if (await prisma.sender.count({ where: { userId } }) >= minCount) return;
    await prisma.sender.updateMany({
      where: { id: sender.id, userId: demoUser.id },
      data: { userId }
    });
  }

  const transferredCount = await prisma.sender.count({ where: { userId } });
  if (transferredCount > currentCount && process.env.NODE_ENV === "development") {
    console.info(`Reassigned ${transferredCount - currentCount} demo sender(s) to user ${userId}.`);
  }
}

async function provisionLocalAccount(
  userId: string,
  account: z.infer<typeof senderAccountSchema>
): Promise<void> {
  const existing = await prisma.sender.findUnique({
    where: { smtpUser: account.user },
    select: { userId: true }
  });
  const isNewSender = existing === null;

  if (existing && existing.userId !== userId) {
    const demoUser = await prisma.user.findUnique({
      where: { email: DEMO_USER_EMAIL },
      select: { id: true }
    });
    if (!demoUser || existing.userId !== demoUser.id) {
      console.warn(`Ethereal sender ${account.user} belongs to another user; skipping it.`);
      return;
    }

    await prisma.sender.updateMany({
      where: { smtpUser: account.user, userId: demoUser.id },
      data: {
        name: account.name,
        smtpHost: "smtp.ethereal.email",
        smtpPort: 587,
        smtpSecure: false,
        smtpPass: account.pass,
        userId
      }
    });
  } else if (existing) {
    await prisma.sender.updateMany({
      where: { smtpUser: account.user, userId },
      data: {
        name: account.name,
        smtpHost: "smtp.ethereal.email",
        smtpPort: 587,
        smtpSecure: false,
        smtpPass: account.pass
      }
    });
  } else {
    try {
      await prisma.sender.upsert({
        where: { smtpUser: account.user },
        create: {
          name: account.name,
          smtpHost: "smtp.ethereal.email",
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: account.user,
          smtpPass: account.pass,
          userId
        },
        update: {}
      });
    } catch (error) {
      if (!isUniqueSenderError(error)) throw error;
      console.warn(`Ethereal sender ${account.user} already exists; skipping it.`);
      return;
    }
  }

  const assigned = await prisma.sender.findUnique({
    where: { smtpUser: account.user },
    select: { userId: true }
  });
  if (isNewSender && assigned?.userId === userId && process.env.NODE_ENV === "development") {
    console.info(`Configured local Ethereal sender ${account.user}.`);
  }
}

export async function ensureSenders(userId: string, minCount = 3): Promise<void> {
  if (!Number.isInteger(minCount) || minCount < 0) {
    throw new RangeError("minCount must be a non-negative integer.");
  }

  const initialCount = await prisma.sender.count({ where: { userId } });
  const missingCount = Math.max(0, minCount - initialCount);
  if (missingCount === 0) return;

  const accounts = await readLocalSenderAccounts();
  for (const account of accounts) {
    if (await prisma.sender.count({ where: { userId } }) >= minCount) break;
    await provisionLocalAccount(userId, account);
  }

  await transferDemoSenders(userId, minCount);

  const fallbackCount = Math.max(0, missingCount - accounts.length);
  for (let index = 0; index < fallbackCount; index += 1) {
    if (await prisma.sender.count({ where: { userId } }) >= minCount) break;

    let assigned = false;
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
      let account: Awaited<ReturnType<typeof nodemailer.createTestAccount>>;
      try {
        account = await nodemailer.createTestAccount();
      } catch (error) {
        console.warn(
          `Could not request an Ethereal account (attempt ${attempt}/${MAX_CREATE_ATTEMPTS}).`,
          error
        );
        if (attempt < MAX_CREATE_ATTEMPTS) await wait(RETRY_DELAY_MS);
        continue;
      }

      const existing = await prisma.sender.findUnique({
        where: { smtpUser: account.user },
        select: { userId: true }
      });
      if (existing) {
        console.warn(
          `Ethereal returned duplicate account ${account.user}; requesting a fresh account (attempt ${attempt}/${MAX_CREATE_ATTEMPTS}).`
        );
      } else {
        try {
          const sender = await prisma.sender.upsert({
            where: { smtpUser: account.user },
            create: {
              name: `Ethereal Sender ${initialCount + accounts.length + index + 1}`,
              smtpHost: "smtp.ethereal.email",
              smtpPort: 587,
              smtpSecure: false,
              smtpUser: account.user,
              smtpPass: account.pass,
              userId
            },
            update: {}
          });

          if (sender.userId !== userId) {
            console.warn(
              `Ethereal returned duplicate account ${account.user}; requesting a fresh account (attempt ${attempt}/${MAX_CREATE_ATTEMPTS}).`
            );
          } else {
            if (process.env.NODE_ENV === "development") {
              console.info(`Created Ethereal sender ${account.user}.`);
            }
            assigned = true;
            break;
          }
        } catch (error) {
          if (!isUniqueSenderError(error)) throw error;
          console.warn(
            `Ethereal returned duplicate account ${account.user}; requesting a fresh account (attempt ${attempt}/${MAX_CREATE_ATTEMPTS}).`
          );
        }
      }

      if (attempt < MAX_CREATE_ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
    if (!assigned) {
      console.warn(
        `Could not add an unused Ethereal account for user ${userId} after ${MAX_CREATE_ATTEMPTS} attempts.`
      );
    }
  }
}
