import { randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import {
  SESSION_COOKIE_NAME
} from "../middleware/authenticateUser.js";
import { prisma } from "../db/prisma.js";
import { authenticateGoogleCode, getGoogleAuthorizationUrl } from "../services/googleOAuthService.js";
import { ensureSenders } from "../services/senderService.js";

const OAUTH_STATE_COOKIE_NAME = "google_oauth_state";

function isHttpsRequest(request?: Request): boolean {
  if (!request) return config.FRONTEND_URL.startsWith("https://");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protoHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return Boolean(request.secure || protoHeader === "https" || config.FRONTEND_URL.startsWith("https://"));
}

function getCookieOptions(path: string, maxAge: number | undefined, request?: Request) {
  const useCrossSiteCookies = isHttpsRequest(request);
  return {
    httpOnly: true,
    secure: useCrossSiteCookies,
    sameSite: useCrossSiteCookies ? "none" as const : "lax" as const,
    path,
    ...(maxAge === undefined ? {} : { maxAge: maxAge * 1000 })
  };
}

function getCookieValue(request: Request, name: string): string | undefined {
  const cookie = request.header("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1);
}

function clearOAuthStateCookie(response: Response, request?: Request): void {
  response.clearCookie(
    OAUTH_STATE_COOKIE_NAME,
    getCookieOptions("/auth/google/callback", undefined, request)
  );
}

export function startGoogleOAuth(request: Request, response: Response): void {
  try {
    const state = randomBytes(32).toString("base64url");
    const authorizationUrl = getGoogleAuthorizationUrl(state);
    response.cookie(
      OAUTH_STATE_COOKIE_NAME,
      state,
      getCookieOptions("/auth/google/callback", config.OAUTH_STATE_TTL_SECONDS, request)
    );
    response.redirect(authorizationUrl);
  } catch (error) {
    clearOAuthStateCookie(response, request);
    response.status(503).json({
      error: error instanceof Error ? error.message : "Google OAuth is unavailable"
    });
  }
}

export async function handleGoogleOAuthCallback(
  request: Request,
  response: Response
): Promise<void> {
  const cookieState = getCookieValue(request, OAUTH_STATE_COOKIE_NAME);
  const queryState = typeof request.query.state === "string" ? request.query.state : undefined;
  const queryCode = typeof request.query.code === "string" ? request.query.code : undefined;
  const loginErrorUrl = `${config.FRONTEND_URL.replace(/\/$/, "")}/login?error=oauth`;
  clearOAuthStateCookie(response, request);

  if (
    !cookieState ||
    !queryState ||
    !/^[A-Za-z0-9_-]{43}$/.test(cookieState) ||
    !/^[A-Za-z0-9_-]{43}$/.test(queryState) ||
    !timingSafeEqual(Buffer.from(cookieState), Buffer.from(queryState))
  ) {
    console.warn("Google OAuth callback had invalid state.");
    response.redirect(loginErrorUrl);
    return;
  }

  if (!queryCode || typeof request.query.error === "string") {
    console.warn("Google OAuth sign-in was declined or did not return a code.");
    response.redirect(loginErrorUrl);
    return;
  }

  try {
    const user = await authenticateGoogleCode(queryCode);
    void ensureSenders(user.id).catch((error: unknown) => {
      console.error(`Could not provision Ethereal senders for user ${user.id}.`, error);
    });
    const token = jwt.sign(
      {},
      config.JWT_SECRET,
      { subject: user.id, expiresIn: config.JWT_TTL_SECONDS }
    );
    response.cookie(
      SESSION_COOKIE_NAME,
      token,
      getCookieOptions("/", config.JWT_TTL_SECONDS, request)
    );
    response.redirect(`${config.FRONTEND_URL.replace(/\/$/, "")}/dashboard`);
  } catch (error) {
    console.error("Google OAuth callback failed.", error);
    if (error instanceof Error && "cause" in error && error.cause !== undefined) {
      console.error("Google OAuth callback failure cause.", error.cause);
    }
    response.redirect(`${config.FRONTEND_URL.replace(/\/$/, "")}/login?error=oauth`);
  }
}

export async function getCurrentUser(
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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, avatarUrl: true }
    });
    if (!user) {
      response.status(401).json({ error: "User account no longer exists" });
      return;
    }
    response.json({ data: user });
  } catch (error) {
    next(error);
  }
}

export function logout(request: Request, response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, getCookieOptions("/", undefined, request));
  response.status(204).end();
}
