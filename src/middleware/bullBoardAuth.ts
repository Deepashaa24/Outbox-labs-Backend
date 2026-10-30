import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "../config/env.js";

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) {
    timingSafeEqual(expectedBytes, Buffer.alloc(expectedBytes.length));
    return false;
  }
  return timingSafeEqual(actualBytes, expectedBytes);
}

export const bullBoardAuth: RequestHandler = (request, response, next) => {
  const authorization = request.header("authorization");
  const encodedCredentials = authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!encodedCredentials) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
    response.status(401).send("Authentication required");
    return;
  }

  let credentials: string;
  try {
    credentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
  } catch {
    response.status(401).send("Invalid credentials");
    return;
  }

  const separator = credentials.indexOf(":");
  const username = separator >= 0 ? credentials.slice(0, separator) : "";
  const password = separator >= 0 ? credentials.slice(separator + 1) : "";
  const validUsername = constantTimeEquals(username, config.BULL_BOARD_USERNAME);
  const validPassword = constantTimeEquals(password, config.BULL_BOARD_PASSWORD);

  if (!validUsername || !validPassword) {
    response.setHeader("WWW-Authenticate", 'Basic realm="Bull Board", charset="UTF-8"');
    response.status(401).send("Invalid credentials");
    return;
  }

  next();
};
