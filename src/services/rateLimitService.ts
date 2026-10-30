import { redis } from "../config/redis.js";

const reserveSenderSlotScript = `
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
if count >= limit then
  return {0, count}
end

local newCount = redis.call("INCR", KEYS[1])
if newCount == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end
return {1, newCount}
`;

export type RateLimitResult =
  | { allowed: true; count: number }
  | { allowed: false; count: number; retryAt: number };

export function getRateLimitKey(senderId: string, timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Cannot create rate-limit key for an invalid timestamp");
  }

  const hour =
    `${date.getUTCFullYear()}` +
    `${String(date.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(date.getUTCDate()).padStart(2, "0")}` +
    `${String(date.getUTCHours()).padStart(2, "0")}`;
  return `rate:${senderId}:${hour}`;
}

export async function checkEmailRateLimit(
  senderId: string,
  requestedLimit: number,
  now = Date.now()
): Promise<RateLimitResult> {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("Sender hourly rate limit must be a positive integer");
  }

  const key = getRateLimitKey(senderId, now);
  const nextHour = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  const ttlSeconds = Math.ceil((nextHour - now) / 1000) + 60;
  const result = await redis.eval(
    reserveSenderSlotScript,
    1,
    key,
    requestedLimit,
    ttlSeconds
  );

  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error("Redis returned an invalid email rate-limit result");
  }

  const allowedValue = result[0];
  const countValue = result[1];
  if (allowedValue === undefined || countValue === undefined) {
    throw new Error("Redis returned an invalid email rate-limit result");
  }
  const allowed = Number(allowedValue);
  const count = Number(countValue);
  if (!Number.isFinite(allowed) || !Number.isFinite(count)) {
    throw new Error("Redis returned an invalid email rate-limit result");
  }

  return allowed === 1
    ? { allowed: true, count }
    : { allowed: false, count, retryAt: nextHour };
}
