import type { BodyReader, HTTPReq } from "../http_types.js";
import type { App } from "./app.js";

export type TestRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | object;
  clientIp?: string;
};

export type TestResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  text: () => string;
  json: <T = unknown>() => T;
};

function makeBodyReader(body: Buffer): BodyReader {
  let done = false;
  return {
    length: body.length,
    read: async () => {
      if (done) return Buffer.from("");
      done = true;
      return body;
    },
  };
}

function normalizeBody(body: TestRequestInit["body"]): Buffer {
  if (body === undefined) return Buffer.from("");
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(JSON.stringify(body), "utf8");
}

function parseHeaders(headers: Buffer[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    const line = header.toString("latin1");
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    result[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return result;
}

export async function request(
  app: App,
  uri: string,
  init: TestRequestInit = {},
): Promise<TestResponse> {
  const method = init.method ?? "GET";
  const body = normalizeBody(init.body);
  const headers = Object.entries(init.headers ?? {}).map(([name, value]) =>
    Buffer.from(`${name}: ${value}`, "latin1"),
  );

  if (body.length > 0 && !init.headers?.["Content-Length"]) {
    headers.push(Buffer.from(`Content-Length: ${body.length}`, "latin1"));
  }
  if (typeof init.body === "object" && !Buffer.isBuffer(init.body)) {
    headers.push(Buffer.from("Content-Type: application/json", "latin1"));
  }

  const raw: HTTPReq = {
    method,
    uri: Buffer.from(uri, "latin1"),
    version: "1.1",
    headers,
  };

  const result = await app.dispatch(raw, makeBodyReader(body), {
    clientIp: init.clientIp ?? "127.0.0.1",
  });

  const chunks: Buffer[] = [];
  while (true) {
    const chunk = await result.response.body.read();
    if (chunk.length === 0) break;
    chunks.push(chunk);
  }

  const responseBody = Buffer.concat(chunks);
  return {
    status: result.response.code,
    headers: parseHeaders(result.response.headers),
    body: responseBody,
    text: () => responseBody.toString("utf8"),
    json: <T = unknown>() => JSON.parse(responseBody.toString("utf8")) as T,
  };
}
