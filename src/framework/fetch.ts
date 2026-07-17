import type { HTTPReq } from "../http_types.js";
import type { App } from "./app.js";
import { readerFromMemory } from "../body_readers.js";

/**
 * Converts the custom App into a standard Fetch API handler.
 * This lets you run the same App in:
 * - Node.js native TCP (default)
 * - node:http createServer via adapter
 * - Edge runtimes (Deno, Bun, Cloudflare Workers)
 */
export function toFetchHandler(app: App): (req: Request) => Promise<Response> {
  return async (fetchReq: Request): Promise<Response> => {
    const url = new URL(fetchReq.url);

    // Build HTTPReq from fetch Request
    const headers: Buffer[] = [];
    fetchReq.headers.forEach((value, key) => {
      headers.push(Buffer.from(`${key}: ${value}`, "latin1"));
    });

    const raw: HTTPReq = {
      method: fetchReq.method,
      uri: Buffer.from(url.pathname + url.search, "latin1"),
      version: "1.1",
      headers,
    };

    // Build body reader from fetch Request body
    let bodyBuffer: Buffer;
    if (fetchReq.body) {
      const chunks: Uint8Array[] = [];
      const reader = fetchReq.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      bodyBuffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    } else {
      bodyBuffer = Buffer.from("");
    }

    const result = await app.dispatch(raw, readerFromMemory(bodyBuffer), {
      clientIp: "127.0.0.1",
    });

    // Convert HTTPRes headers to fetch Headers
    const responseHeaders = new Headers();
    for (const h of result.response.headers) {
      const line = h.toString("latin1");
      const idx = line.indexOf(":");
      if (idx > 0) {
        responseHeaders.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      }
    }

    // Collect response body
    const bodyChunks: Buffer[] = [];
    while (true) {
      const chunk = await result.response.body.read();
      if (chunk.length === 0) break;
      bodyChunks.push(chunk);
    }
    const responseBody = Buffer.concat(bodyChunks);

    return new Response(responseBody.length > 0 ? responseBody : null, {
      status: result.response.code,
      statusText: statusReason(result.response.code),
      headers: responseHeaders,
    });
  };
}

function statusReason(code: number): string {
  const m: Record<number, string> = {
    101: "Switching Protocols",
    200: "OK",
    201: "Created",
    204: "No Content",
    206: "Partial Content",
    301: "Moved Permanently",
    302: "Found",
    304: "Not Modified",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Payload Too Large",
    416: "Range Not Satisfiable",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
  };
  return m[code] ?? "OK";
}
