import { TokenBucketRateLimiter } from "../rate_limit.js";
import type { AppHandler } from "./types.js";

function formatSizeKb(bodyLength: number): string {
  if (bodyLength < 0) return "—";
  return (bodyLength / 1024).toFixed(2);
}

/** Structured logger interface. */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Default console-based logger. */
export const defaultLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", message: msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", message: msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", message: msg, ...meta })),
};

/** Create a logger middleware with the given logger instance. */
export function logger(log: Logger = defaultLogger): AppHandler {
  return async (c, next) => {
    const start = performance.now();
    let error: unknown;
    try {
      await next();
    } catch (err) {
      error = err;
      throw err;
    } finally {
      const ms = Math.round(performance.now() - start);
      const code = c.response ? String(c.response.code) : "ERR";
      const kb = c.response ? formatSizeKb(c.response.body.length) : "—";
      const meta: Record<string, unknown> = {
        method: c.req.method,
        path: c.req.path,
        status: code,
        durationMs: ms,
        sizeKb: kb,
        clientIp: c.clientIp,
      };
      if (error) meta.error = String(error);
      log.info("HTTP request", meta);
    }
  };
}

/** CORS middleware with configurable options. */
export function cors(options?: {
  origin?: string | string[];
  methods?: string;
  headers?: string;
  credentials?: boolean;
  maxAge?: number;
}): AppHandler {
  const opts = options ?? {};
  const origin = opts.origin ?? "*";
  const methods = opts.methods ?? "GET,POST,PUT,DELETE,PATCH,OPTIONS";
  const allowHeaders = opts.headers ?? "Content-Type,Authorization";

  function resolveOrigin(reqOrigin: string | undefined): string {
    if (Array.isArray(origin)) {
      if (reqOrigin && origin.includes(reqOrigin)) return reqOrigin;
      return origin[0] ?? "*";
    }
    return origin;
  }

  return async (c, next) => {
    // Handle preflight
    if (c.req.method === "OPTIONS") {
      const allowOrigin = resolveOrigin(c.req.header("Origin"));
      c.header("Access-Control-Allow-Origin", allowOrigin);
      c.header("Access-Control-Allow-Methods", methods);
      c.header("Access-Control-Allow-Headers", allowHeaders);
      if (opts.credentials) c.header("Access-Control-Allow-Credentials", "true");
      if (opts.maxAge) c.header("Access-Control-Max-Age", String(opts.maxAge));
      return c.status(204).text("");
    }

    await next();

    const allowOrigin = resolveOrigin(c.req.header("Origin"));
    c.header("Access-Control-Allow-Origin", allowOrigin);
    if (opts.credentials) c.header("Access-Control-Allow-Credentials", "true");
  };
}

/** Rate-limiting middleware. */
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

/** Compress JSON/text responses with gzip when client accepts it. */
export function compress(): AppHandler {
  return async (c, next) => {
    await next();
    if (!c.response) return;
    const accept = c.req.header("Accept-Encoding") ?? "";
    if (!accept.includes("gzip")) return;

    const contentType = c.response.headers
      .find((h) => h.toString("latin1").toLowerCase().startsWith("content-type:"))
      ?.toString("latin1")
      .toLowerCase() ?? "";

    // Only compress text types
    const compressible =
      contentType.includes("text/") ||
      contentType.includes("application/json") ||
      contentType.includes("application/javascript") ||
      contentType.includes("application/xml");
    if (!compressible) return;

    const { gzipSync } = await import("node:zlib");
    const chunks: Buffer[] = [];
    while (true) {
      const chunk = await c.response.body.read();
      if (chunk.length === 0) break;
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (raw.length < 1024) return; // don't compress tiny responses

    const compressed = gzipSync(raw);
    c.response.body = { length: compressed.length, read: async () => compressed };
    c.header("Content-Encoding", "gzip");
    c.header("Vary", "Accept-Encoding");
  };
}
