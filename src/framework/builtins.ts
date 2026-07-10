import { TokenBucketRateLimiter } from "../rate_limit.js";
import type { AppHandler } from "./types.js";

function formatSizeKb(bodyLength: number): string {
  if (bodyLength < 0) return "—";
  return (bodyLength / 1024).toFixed(2);
}

export function logger(): AppHandler {
  return async (c, next) => {
    const start = performance.now();
    try {
      await next();
    } finally {
      const ms = Math.round(performance.now() - start);
      const code = c.response ? String(c.response.code) : "ERR";
      const kb = c.response ? formatSizeKb(c.response.body.length) : "—";
      console.log(`${c.req.method} ${c.req.path} ${code} ${ms}ms ${kb}kb`);
    }
  };
}

export function cors(origin = "*"): AppHandler {
  return async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", origin);
  };
}

export function rateLimit(
  limiter = new TokenBucketRateLimiter(),
): AppHandler {
  return async (c, next) => {
    const result = limiter.tryConsume(c.clientIp, Date.now());
    if (!result.ok) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.status(429).text("Too Many Requests\n");
    }
    await next();
  };
}
