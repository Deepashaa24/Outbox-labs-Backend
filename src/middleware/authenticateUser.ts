import jwt from "jsonwebtoken";
import type { RequestHandler } from "express";
import { config } from "../config/env.js";

export const SESSION_COOKIE_NAME = "email_scheduler_session";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  const cookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1);
}

export const authenticateUser: RequestHandler = (request, response, next) => {
  const authorization = request.header("authorization");
  const token = getCookieValue(request.header("cookie"), SESSION_COOKIE_NAME)
    ?? authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      response.status(401).json({ error: "Invalid authentication token" });
      return;
    }

    request.user = { id: payload.sub };
    next();
  } catch {
    response.status(401).json({ error: "Invalid or expired authentication token" });
  }
};
