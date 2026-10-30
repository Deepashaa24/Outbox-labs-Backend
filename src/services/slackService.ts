import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config/env.js";
import { redis } from "../config/redis.js";
import { prisma } from "../db/prisma.js";

const slackOAuthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  incoming_webhook: z.object({
    url: z.string().url(),
    channel_id: z.string().min(1)
  })
});
const slackMessageResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
});

interface SlackOAuthState {
  userId: string;
  nonce: string;
}

const SLACK_OAUTH_STATE_KEY_PREFIX = "slack:oauth-state:";

export class SlackNotConnectedError extends Error {
  readonly status = 409;

  constructor() {
    super("Slack is not connected. Connect a Slack workspace first.");
    this.name = "SlackNotConnectedError";
  }
}

export class SlackWebhookError extends Error {
  readonly status = 502;

  constructor(statusCode: number, errorCode: string) {
    if (errorCode === "messages_tab_disabled") {
      super(
        "Slack rejected a message to the selected destination because its Messages tab is disabled. Choose a regular Slack channel during reconnection and confirm the app has the chat:write bot scope."
      );
      this.name = "SlackWebhookError";
      return;
    }
    super(
      errorCode
        ? `Slack message API returned HTTP ${statusCode}: ${errorCode}`
        : `Slack message API returned HTTP ${statusCode}.`
    );
    this.name = "SlackWebhookError";
  }
}

function getCallbackUrl(): string {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET || !config.SLACK_CALLBACK_URL) {
    throw new Error("Slack OAuth is not configured. Set its client ID, secret, and callback URL.");
  }
  if (config.SLACK_CLIENT_ID.endsWith(".apps.googleusercontent.com")) {
    throw new Error(
      "SLACK_CLIENT_ID is a Google OAuth client ID. Use the Client ID from your Slack app's Basic Information settings."
    );
  }
  return config.SLACK_CALLBACK_URL;
}

export function createSlackAuthorizationUrl(state: string): string {
  const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizationUrl.search = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "incoming-webhook,chat:write",
    redirect_uri: getCallbackUrl(),
    state
  }).toString();
  return authorizationUrl.toString();
}

export async function createSlackOAuthState(userId: string): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  const stored = await redis.set(
    `${SLACK_OAUTH_STATE_KEY_PREFIX}${nonce}`,
    userId,
    "EX",
    config.OAUTH_STATE_TTL_SECONDS,
    "NX"
  );
  if (stored !== "OK") {
    throw new Error("Could not store Slack OAuth state. Please try again.");
  }

  const state: SlackOAuthState = { userId, nonce };
  return jwt.sign(
    { userId: state.userId, nonce: state.nonce, purpose: "slack_oauth" },
    config.JWT_SECRET,
    {
      subject: state.userId,
      expiresIn: config.OAUTH_STATE_TTL_SECONDS,
      algorithm: "HS256"
    }
  );
}

export async function verifySlackOAuthState(token: string): Promise<string | null> {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return null;
  }

  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    payload.userId !== payload.sub ||
    payload.purpose !== "slack_oauth" ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1000) ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce)
  ) {
    return null;
  }

  const key = `${SLACK_OAUTH_STATE_KEY_PREFIX}${payload.nonce}`;
  const storedUserId: unknown = await redis.eval(
    "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
    1,
    key
  );
  if (
    typeof storedUserId !== "string" ||
    storedUserId.length !== payload.sub.length ||
    !timingSafeEqual(Buffer.from(storedUserId), Buffer.from(payload.sub))
  ) {
    return null;
  }

  return payload.sub;
}

export async function connectSlackWorkspace(userId: string, code: string): Promise<void> {
  const callbackUrl = getCallbackUrl();
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.SLACK_CLIENT_ID,
      client_secret: config.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`Slack token exchange failed with status ${response.status}.`);
  }

  const parsed = slackOAuthResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Slack did not return a valid incoming webhook connection.");
  }

  const webhookUrl = new URL(parsed.data.incoming_webhook.url);
  if (webhookUrl.protocol !== "https:" || webhookUrl.hostname !== "hooks.slack.com") {
    throw new Error("Slack returned an unexpected incoming webhook URL.");
  }

  await prisma.slackConnection.upsert({
    where: { userId },
    create: {
      userId,
      accessToken: parsed.data.access_token,
      webhookUrl: webhookUrl.toString(),
      channelId: parsed.data.incoming_webhook.channel_id
    },
    update: {
      accessToken: parsed.data.access_token,
      webhookUrl: webhookUrl.toString(),
      channelId: parsed.data.incoming_webhook.channel_id
    }
  });
}

export async function getSlackConnectionStatus(userId: string): Promise<{ connected: boolean }> {
  const connection = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { id: true, accessToken: true, channelId: true }
  });
  return { connected: Boolean(connection?.accessToken && connection.channelId) };
}

async function postSlackMessage(
  accessToken: string,
  channelId: string,
  message: string
): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({ channel: channelId, text: message }),
    signal: AbortSignal.timeout(15_000)
  });
  const responseText = await response.text();
  let errorCode = "";
  try {
    const parsed = slackMessageResponseSchema.safeParse(JSON.parse(responseText) as unknown);
    if (parsed.success && !parsed.data.ok) errorCode = parsed.data.error ?? "unknown_error";
  } catch {
    errorCode = "invalid_response";
  }
  if (!response.ok || errorCode || responseText.length === 0) {
    console.error("Slack message API request failed.", {
      status: response.status,
      error: errorCode || "unexpected_response"
    });
    throw new SlackWebhookError(response.status, errorCode);
  }
}

export async function sendSlackTestMessage(userId: string): Promise<void> {
  const connection = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { accessToken: true, channelId: true }
  });
  if (!connection?.accessToken || !connection.channelId) {
    throw new SlackNotConnectedError();
  }

  await postSlackMessage(
    connection.accessToken,
    connection.channelId,
    "Slack integration test message."
  );
}

export async function disconnectSlackWorkspace(userId: string): Promise<void> {
  const connection = await prisma.slackConnection.findUnique({
    where: { userId },
    select: { accessToken: true }
  });
  if (!connection) return;

  if (connection.accessToken) {
    const response = await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${connection.accessToken}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      throw new Error(`Slack token revocation failed with status ${response.status}.`);
    }
    const result = await response.json() as { ok?: boolean };
    if (result.ok !== true) {
      throw new Error("Slack did not revoke the connected workspace token.");
    }
  }

  await prisma.slackConnection.deleteMany({ where: { userId } });
}

export async function notifySlackRateLimit(userId: string, senderId: string): Promise<void> {
  const now = new Date();
  const hourKey = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0")
  ].join("");
  const dedupeKey = `slack:rate-limit-notified:${senderId}:${hourKey}`;
  const nextHourAt = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours() + 1
  );
  const secondsUntilNextHour = Math.max(1, Math.ceil((nextHourAt - now.getTime()) / 1000));

  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
      select: { accessToken: true, channelId: true }
    });
    if (!connection?.accessToken || !connection.channelId) return;

    const claimId = randomUUID();
    const claimed = await redis.set(
      dedupeKey,
      claimId,
      "EX",
      secondsUntilNextHour,
      "NX"
    );
    if (claimed !== "OK") return;

    await postSlackMessage(
      connection.accessToken,
      connection.channelId,
      `Email scheduling is paused for sender \`${senderId}\` because its hourly rate limit was reached. Queued emails will resume in the next hour window.`
    );
    await redis.set(
      dedupeKey,
      "sent",
      "EX",
      Math.max(1, Math.ceil((nextHourAt - Date.now()) / 1000))
    );
  } catch (error) {
    console.error("Slack rate-limit notification failed.", error);
  }
}

export async function notifySlack(userId: string, message: string): Promise<void> {
  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId },
      select: { accessToken: true, channelId: true }
    });
    if (!connection?.accessToken || !connection.channelId) return;

    await postSlackMessage(connection.accessToken, connection.channelId, message);
  } catch (error) {
    console.error("Slack notification failed.", error);
  }
}
