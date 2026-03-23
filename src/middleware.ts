import type { BodyReader, HTTPReq, HTTPRes } from "./http_types.js";
import { readerFromMemory } from "./body_readers.js";
import { urlPathname } from "./file_server.js";
import { TokenBucketRateLimiter } from "./rate_limit.js";

/**
 * Holds the request body reader and the `HTTPRes` produced by the inner handler.
 * The second argument is named `res` by analogy with Express; `response` is your `HTTPRes`.
 */
export type MiddlewareRes = {
  readonly body: BodyReader;
  response: HTTPRes | null;
  /** TCP remote address (normalized); set by the server for rate limiting / logging. */
  readonly clientIp: string;
};

export type NextFn = () => Promise<void>;

/**
 * Async middleware: call `await next()` to run the rest of the chain, then run your
 * "after" logic (e.g. logging, adding headers to `res.response`).
 */
export type Middleware = (
  req: HTTPReq,
  res: MiddlewareRes,
  next: NextFn
) => Promise<void>;

/** Options passed from the TCP layer into the pipeline. */
export type HttpPipelineRunOptions = {
  clientIp: string;
};

function compose(
  stack: Middleware[],
  handler: (req: HTTPReq, body: BodyReader) => Promise<HTTPRes>
): (
  req: HTTPReq,
  body: BodyReader,
  opts: HttpPipelineRunOptions
) => Promise<HTTPRes> {
  return async (
    req: HTTPReq,
    body: BodyReader,
    opts: HttpPipelineRunOptions
  ): Promise<HTTPRes> => {
    const res: MiddlewareRes = {
      body,
      response: null,
      clientIp: opts.clientIp,
    };
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      if (i === stack.length) {
        res.response = await handler(req, body);
        return;
      }
      await stack[i]!(req, res, () => dispatch(i + 1));
    };

    await dispatch(0);
    if (!res.response) {
      throw new Error("Middleware pipeline finished without setting res.response");
    }
    return res.response;
  };
}

/**
 * Register middleware in order: first `use()` runs outermost (first to `await next()`,
 * last to run code after `next()` returns).
 */
export class HttpPipeline {
  private readonly stack: Middleware[] = [];

  use(mw: Middleware): this {
    this.stack.push(mw);
    return this;
  }

  /**
   * Produces `(req, body, opts) => Promise<HTTPRes>` for `http_server` / your TCP loop.
   */
  finalize(
    handler: (req: HTTPReq, body: BodyReader) => Promise<HTTPRes>
  ): (req: HTTPReq, body: BodyReader, opts: HttpPipelineRunOptions) => Promise<HTTPRes> {
    return compose(this.stack.slice(), handler);
  }
}

function formatSizeKb(bodyLength: number): string {
  if (bodyLength < 0) return "—";
  return (bodyLength / 1024).toFixed(2);
}

/**
 * Logs one line per request: method, path, status, duration (ms), size (kb).
 * Chunked / unknown-length bodies show `—` for size.
 */
export async function loggerMiddleware(
  req: HTTPReq,
  res: MiddlewareRes,
  next: NextFn
): Promise<void> {
  const start = performance.now();
  const path = urlPathname(req.uri);
  try {
    await next();
  } finally {
    const ms = Math.round(performance.now() - start);
    const http = res.response;
    const code = http ? String(http.code) : "ERR";
    const kb = http ? formatSizeKb(http.body.length) : "—";
    console.log(`${req.method} ${path} ${code} ${ms}ms ${kb}kb`);
  }
}

/** Adds permissive CORS headers to the response after the handler runs. */
export async function corsMiddleware(
  _req: HTTPReq,
  res: MiddlewareRes,
  next: NextFn
): Promise<void> {
  await next();
  if (res.response) {
    res.response.headers.push(Buffer.from("Access-Control-Allow-Origin: *"));
  }
}

export function createRateLimitMiddleware(
  limiter: TokenBucketRateLimiter
): Middleware {
  return async (_req, res, next) => {
    const result = limiter.tryConsume(res.clientIp, Date.now());
    if (!result.ok) {
      res.response = {
        code: 429,
        headers: [
          Buffer.from("Server: http-web-server"),
          Buffer.from(`Retry-After: ${result.retryAfterSec}`),
        ],
        body: readerFromMemory(Buffer.from("Too Many Requests\n")),
      };
      return;
    }
    await next();
  };
}

/** Shared limiter for the default pipeline in `http_server.ts`. */
const defaultRateLimiter = new TokenBucketRateLimiter();

export const rateLimitMiddleware = createRateLimitMiddleware(defaultRateLimiter);
