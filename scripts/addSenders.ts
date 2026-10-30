import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import "../src/config/env.js";
import { prisma } from "../src/db/prisma.js";

const localSenderPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../senders.local.json"
);
const senderSchema = z.object({
  name: z.string().trim().min(1),
  user: z.string().trim().email(),
  pass: z.string().min(1)
});
const sendersSchema = z.array(senderSchema).min(1);

async function loadSenders(): Promise<z.infer<typeof sendersSchema>> {
  const contents = await readFile(localSenderPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${localSenderPath}.`, { cause: error });
  }

  const parsed = sendersSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid sender configuration in ${localSenderPath}.`, {
      cause: parsed.error
    });
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const senders = await loadSenders();
  const ownerEmail = process.env.SENDER_OWNER_EMAIL?.trim().toLowerCase();
  const users = ownerEmail
    ? await prisma.user.findMany({
        where: { email: ownerEmail },
        select: { id: true, email: true }
      })
    : await prisma.user.findMany({
        orderBy: { email: "asc" },
        select: { id: true, email: true }
      });

  if (users.length === 0) {
    if (ownerEmail) {
      throw new Error(`No user found for SENDER_OWNER_EMAIL=${ownerEmail}.`);
    }
    console.info("No users exist; sender import skipped.");
    return;
  }

  for (const user of users) {
    for (const sender of senders) {
      const current = await prisma.sender.findUnique({
        where: { smtpUser: sender.user },
        select: {
          name: true,
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
          smtpUser: true,
          smtpPass: true,
          userId: true
        }
      });
      const unchanged = current !== null &&
        current.name === sender.name &&
        current.smtpHost === "smtp.ethereal.email" &&
        current.smtpPort === 587 &&
        current.smtpSecure === false &&
        current.smtpPass === sender.pass &&
        current.userId === user.id;

      if (unchanged) {
        console.info(`skipped ${sender.name} (${sender.user}) for ${user.email}`);
        continue;
      }

      await prisma.sender.upsert({
        where: { smtpUser: sender.user },
        create: {
          name: sender.name,
          smtpHost: "smtp.ethereal.email",
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: sender.user,
          smtpPass: sender.pass,
          userId: user.id
        },
        update: {
          name: sender.name,
          smtpHost: "smtp.ethereal.email",
          smtpPort: 587,
          smtpSecure: false,
          smtpPass: sender.pass,
          userId: user.id
        }
      });

      console.info(
        `${current ? "updated" : "created"} ${sender.name} (${sender.user}) for ${user.email}`
      );
      if (!current && process.env.NODE_ENV === "development") {
        console.info(`Created Ethereal sender credentials for ${sender.user}: ${sender.pass}`);
      }
    }

    const senderCount = await prisma.sender.count({ where: { userId: user.id } });
    console.info(`Final sender count for ${user.email}: ${senderCount}`);
    if (ownerEmail && senderCount < 1) {
      throw new Error(`Target user ${user.email} has no senders after import.`);
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error("Could not add configured senders.", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
