import type { BodyReader, HTTPReq, HTTPRes } from "../http_types.js";
import { readerFromMemory } from "../body_readers.js";
import type { RouteParams } from "../router.js";
import { AppRequest } from "./request.js";
import type {
  ContextResponseInit,
  ValidationTarget,
  WebSocketRouteSession,
} from "./types.js";

function upsertHeader(headers: Buffer[], name: string, value: string): void {
  const lower = name.toLowerCase();
  const next = Buffer.from(`${name}: ${value}`, "latin1");
  for (let i = headers.length - 1; i >= 0; i--) {
    const line = headers[i]?.toString("latin1") ?? "";
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (key === lower) {
      headers.splice(i, 1);
    }
  }
  headers.push(next);
}

function toBodyReader(content: BodyReader | Buffer | string): BodyReader {
  if (typeof content === "string") {
    return readerFromMemory(Buffer.from(content, "utf8"));
  }
  if (Buffer.isBuffer(content)) {
    return readerFromMemory(content);
  }
  return content;
}

type HeaderStoreValue = {
  name: string;
  value: string;
};

export class Context {
  readonly req: AppRequest;
  readonly clientIp: string;

  response: HTTPRes | null = null;

  private statusCode = 200;
  private statusWasSet = false;
  private readonly headerStore = new Map<string, HeaderStoreValue>();
  private readonly validated = new Map<ValidationTarget, unknown>();
  private websocketRouteSession: WebSocketRouteSession | null = null;

  constructor(req: HTTPReq, body: BodyReader, params: RouteParams, clientIp: string) {
    this.req = new AppRequest(req, body, params);
    this.clientIp = clientIp;
    this.header("Server", "http-web-server");
  }

  status(code: number): this {
    this.statusCode = code;
    this.statusWasSet = true;
    if (this.response) this.response.code = code;
    return this;
  }

  header(name: string, value: string): this {
    this.headerStore.set(name.toLowerCase(), { name, value });
    if (this.response) {
      upsertHeader(this.response.headers, name, value);
    }
    return this;
  }

  body(content: BodyReader | Buffer | string, init: ContextResponseInit = {}): HTTPRes {
    const body = toBodyReader(content);
    const headers = this.buildHeaders(init.headers, init.contentType);
    const response: HTTPRes = {
      code: init.status ?? this.statusCode,
      headers,
      body,
    };
    if (init.chunked === true) {
      response.chunked = true;
    }
    if (init.headOnly === true) {
      response.headOnly = true;
    }
    this.response = response;
    this.statusCode = response.code;
    return response;
  }

  text(data: string, init: ContextResponseInit = {}): HTTPRes {
    return this.body(data, {
      ...init,
      contentType: init.contentType ?? "text/plain; charset=utf-8",
    });
  }

  json(data: unknown, init: ContextResponseInit = {}): HTTPRes {
    return this.body(JSON.stringify(data), {
      ...init,
      contentType: init.contentType ?? "application/json; charset=utf-8",
    });
  }

  html(data: string, init: ContextResponseInit = {}): HTTPRes {
    return this.body(data, {
      ...init,
      contentType: init.contentType ?? "text/html; charset=utf-8",
    });
  }

  valid<T = unknown>(target: ValidationTarget): T {
    if (!this.validated.has(target)) {
      throw new Error(`No validated data stored for target: ${target}`);
    }
    return this.validated.get(target) as T;
  }

  setValid(target: ValidationTarget, value: unknown): void {
    this.validated.set(target, value);
  }

  setWebSocketSession(session: WebSocketRouteSession): void {
    this.websocketRouteSession = session;
  }

  getWebSocketSession(): WebSocketRouteSession | null {
    return this.websocketRouteSession;
  }

  setResponse(response: HTTPRes): HTTPRes {
    for (const { name, value } of this.headerStore.values()) {
      upsertHeader(response.headers, name, value);
    }
    if (this.statusWasSet) {
      response.code = this.statusCode;
    }
    this.response = response;
    return response;
  }

  private buildHeaders(
    extraHeaders: Record<string, string> = {},
    contentType?: string,
  ): Buffer[] {
    const merged = new Map<string, HeaderStoreValue>(this.headerStore);
    if (contentType) {
      merged.set("content-type", {
        name: "Content-Type",
        value: contentType,
      });
    }
    for (const [name, value] of Object.entries(extraHeaders)) {
      merged.set(name.toLowerCase(), { name, value });
    }
    return Array.from(merged.values(), ({ name, value }) =>
      Buffer.from(`${name}: ${value}`, "latin1"),
    );
  }
}
