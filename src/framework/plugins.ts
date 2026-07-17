import crypto from "node:crypto";
import type { App } from "./app.js";
import type { Plugin } from "./types.js";
import { HTTPError } from "../http_types.js";

/** Simple HMAC-SHA256 JWT sign/verify (no external deps). */
function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Buffer {
  const padding = 4 - (str.length % 4);
  if (padding !== 4) {
    str += "=".repeat(padding);
  }
  return Buffer.from(str, "base64url");
}

function hmacSha256(key: string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function jwtSign(payload: Record<string, unknown>, secret: string): string {
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"));
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = base64UrlEncode(hmacSha256(secret, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

function jwtVerify(token: string, secret: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [headerB64, bodyB64, sigB64] = parts;
  const expectedSig = base64UrlEncode(hmacSha256(secret, `${headerB64}.${bodyB64}`));
  if (sigB64 !== expectedSig) throw new Error("Invalid JWT signature");
  const payload = JSON.parse(base64UrlDecode(bodyB64).toString("utf8")) as Record<string, unknown>;
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
    throw new Error("JWT expired");
  }
  return payload;
}

/** JWT authentication plugin. */
export function jwtAuth(options: {
  secret: string;
  cookie?: string;
  header?: string;
}): Plugin {
  return {
    name: "jwtAuth",
    install(app) {
      app.use(async (c, next) => {
        let token: string | undefined;
        if (options.cookie) {
          const cookieHeader = c.req.header("Cookie") ?? "";
          const match = cookieHeader.match(new RegExp(`${options.cookie}=([^;]+)`));
          token = match?.[1];
        }
        if (!token && options.header) {
          const authHeader = c.req.header(options.header) ?? "";
          token = authHeader.replace(/^Bearer\s+/i, "");
        }
        if (!token) {
          const authHeader = c.req.header("Authorization") ?? "";
          token = authHeader.replace(/^Bearer\s+/i, "");
        }
        if (!token) {
          throw new HTTPError(401, "Unauthorized: missing token");
        }
        try {
          const payload = jwtVerify(token, options.secret);
          c.set("jwt", payload);
          c.set("user", payload);
        } catch {
          throw new HTTPError(401, "Unauthorized: invalid token");
        }
        await next();
      });
    },
  };
}

/** Helper to generate a JWT token. */
export function signJwt(payload: Record<string, unknown>, secret: string, expiresInSec?: number): string {
  const full = { ...payload };
  if (expiresInSec) {
    full.exp = Math.floor(Date.now() / 1000) + expiresInSec;
  }
  return jwtSign(full, secret);
}

/** Cookie parser plugin — parses cookies into c.get("cookies"). */
export function cookieParser(): Plugin {
  return {
    name: "cookieParser",
    install(app) {
      app.use(async (c, next) => {
        const raw = c.req.header("Cookie") ?? "";
        const cookies = new Map<string, string>();
        for (const part of raw.split(";")) {
          const eq = part.indexOf("=");
          if (eq > 0) {
            cookies.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
          }
        }
        c.set("cookies", cookies);
        await next();
      });
    },
  };
}

/** Request ID plugin — assigns a unique request ID to every request. */
export function requestId(): Plugin {
  return {
    name: "requestId",
    install(app) {
      app.use(async (c, next) => {
        const id = crypto.randomUUID();
        c.set("requestId", id);
        c.header("X-Request-Id", id);
        await next();
      });
    },
  };
}

/** Health check plugin — adds a /health route. */
export function healthCheck(path = "/health"): Plugin {
  return {
    name: "healthCheck",
    install(app) {
      app.get(path, (c) => c.json({ status: "ok", time: Date.now() }));
    },
  };
}

/** Helmet-style security headers plugin. */
export function helmet(): Plugin {
  return {
    name: "helmet",
    install(app) {
      app.use(async (c, next) => {
        await next();
        c.header("X-Content-Type-Options", "nosniff");
        c.header("X-Frame-Options", "DENY");
        c.header("Referrer-Policy", "strict-origin-when-cross-origin");
        c.header("X-DNS-Prefetch-Control", "off");
        c.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
      });
    },
  };
}

/** Body size limit plugin. */
export function bodyLimit(maxBytes: number): Plugin {
  return {
    name: "bodyLimit",
    install(app) {
      app.use(async (c, next) => {
        const contentLength = c.req.header("Content-Length");
        if (contentLength) {
          const len = parseInt(contentLength, 10);
          if (!isNaN(len) && len > maxBytes) {
            throw new HTTPError(413, "Request body too large");
          }
        }
        await next();
      });
    },
  };
}
