import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error("Unhandled API error.", error);
  const statusCode =
    typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 500;
  const message = statusCode < 500 && error instanceof Error
    ? error.message
    : "Internal server error";
  response.status(statusCode).json({ error: message });
};
