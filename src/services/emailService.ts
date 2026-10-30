import nodemailer, { type Transporter } from "nodemailer";
import type { Sender } from "@prisma/client";
import { config } from "../config/env.js";

export async function sendEmail(
  sender: Sender,
  recipient: string,
  subject: string,
  body: string
): Promise<string | undefined> {
  const transporter: Transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    connectionTimeout: config.SMTP_TIMEOUT_MS,
    greetingTimeout: config.SMTP_TIMEOUT_MS,
    socketTimeout: config.SMTP_TIMEOUT_MS,
    auth: { user: sender.smtpUser, pass: sender.smtpPass }
  });
  try {
    const result = await transporter.sendMail({
      from: sender.smtpUser,
      to: recipient,
      subject,
      text: body
    });
    return nodemailer.getTestMessageUrl(result) || undefined;
  } finally {
    transporter.close();
  }
}
