import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import {
  connectSlackWorkspace,
  createSlackAuthorizationUrl,
  createSlackOAuthState,
  disconnectSlackWorkspace,
  getSlackConnectionStatus,
  SlackWebhookError,
  sendSlackTestMessage,
  verifySlackOAuthState
} from "../services/slackService.js";

export async function connectSlack(request: Request, response: Response): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const state = await createSlackOAuthState(userId);
    const authorizationUrl = createSlackAuthorizationUrl(state);
    response.redirect(authorizationUrl);
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : "Slack OAuth is unavailable"
    });
  }
}

export async function slackOAuthCallback(
  request: Request,
  response: Response
): Promise<void> {
  const loginErrorUrl = `${config.FRONTEND_URL.replace(/\/$/, "")}/login?error=oauth`;
  const state = typeof request.query.state === "string" ? request.query.state : undefined;
  const code = typeof request.query.code === "string" ? request.query.code : undefined;

  if (!state) {
    console.error("Slack OAuth callback did not include state.");
    response.redirect(loginErrorUrl);
    return;
  }
  let userId: string | null;
  try {
    userId = await verifySlackOAuthState(state);
  } catch (error) {
    console.error("Could not verify Slack OAuth state.", error);
    response.redirect(loginErrorUrl);
    return;
  }
  if (!userId) {
    console.warn("Slack OAuth callback had invalid or expired state.");
    response.redirect(loginErrorUrl);
    return;
  }
  if (!code || typeof request.query.error === "string") {
    console.warn("Slack OAuth connection was declined or did not return a code.");
    response.redirect(loginErrorUrl);
    return;
  }

  try {
    await connectSlackWorkspace(userId, code);
    response.redirect(`${config.FRONTEND_URL.replace(/\/$/, "")}/dashboard?slack=connected`);
  } catch (error) {
    console.error("Slack OAuth callback failed.", error);
    if (error instanceof Error && "cause" in error && error.cause !== undefined) {
      console.error("Slack OAuth callback failure cause.", error.cause);
    }
    response.redirect(loginErrorUrl);
  }
}

export async function getSlackStatus(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    response.json({ data: await getSlackConnectionStatus(userId) });
  } catch (error) {
    next(error);
  }
}

export async function sendSlackTest(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    await sendSlackTestMessage(userId);
    response.json({ data: { sent: true } });
  } catch (error) {
    if (error instanceof SlackWebhookError) {
      const hint = error.slackErrorCode === "messages_tab_disabled"
        ? "Reconnect Slack and select a regular channel; confirm the bot has the chat:write scope."
        : error.slackErrorCode === "channel_not_found"
          ? "Slack could not find the saved channel or its webhook. Disconnect Slack, reconnect it, and select a channel that still exists."
          : error.slackErrorCode === "webhook_failed" && error.upstreamStatus >= 500
            ? "Slack returned a server error. Retry shortly; if it continues, disconnect and reconnect Slack to refresh the channel webhook."
            : error.slackErrorCode === "webhook_failed"
              ? "Disconnect Slack and reconnect it, selecting an existing channel where the app is installed."
          : "If this persists, reconnect Slack and select a channel where the app is installed.";
      response.status(error.status).json({
        error: error.message,
        hint
      });
      return;
    }
    next(error);
  }
}

export async function disconnectSlack(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  const userId = request.user?.id;
  if (!userId) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    await disconnectSlackWorkspace(userId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
}
