import type { BodyReader, HTTPReq } from "../http_types.js";
import { HTTPError } from "../http_types.js";
import { fieldGet } from "../http_parser.js";
import type { RouteParams } from "../router.js";
import { urlPathname } from "../file_server.js";

export type QueryValue = string | string[];

export type QueryParams = Record<string, QueryValue>;

export const DEFAULT_MAX_BUFFERED_BODY_BYTES = 1024 * 1024;

export class AppRequest {
  readonly raw: HTTPReq;
  readonly bodyReader: BodyReader;

  private readonly routeParams: RouteParams;
  private readonly maxBufferedBodyBytes: number;
  private urlCache: URL | null = null;
  private bodyBufferPromise: Promise<Buffer> | null = null;

  constructor(
    raw: HTTPReq,
    bodyReader: BodyReader,
    params: RouteParams,
    maxBufferedBodyBytes = DEFAULT_MAX_BUFFERED_BODY_BYTES,
  ) {
    this.raw = raw;
    this.bodyReader = bodyReader;
    this.routeParams = { ...params };
    this.maxBufferedBodyBytes = maxBufferedBodyBytes;
  }

  get method(): string {
    return this.raw.method;
  }

  get version(): string {
    return this.raw.version;
  }

  get path(): string {
    return urlPathname(this.raw.uri);
  }

  header(name: string): string | undefined {
    return fieldGet(this.raw.headers, name)?.toString("latin1");
  }

  param(name: string): string | undefined {
    return this.routeParams[name];
  }

  params(): RouteParams {
    return { ...this.routeParams };
  }

  query(): QueryParams;
  query(name: string): QueryValue | undefined;
  query(name?: string): QueryParams | QueryValue | undefined {
    if (name) {
      const values = this.url.searchParams.getAll(name);
      if (values.length === 0) return undefined;
      return values.length === 1 ? values[0] : values;
    }
    return this.queries();
  }

  queries(): QueryParams {
    const result: QueryParams = {};
    const seen = new Set<string>();
    for (const key of this.url.searchParams.keys()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const values = this.url.searchParams.getAll(key);
      if (values.length === 1) {
        const first = values[0];
        if (first !== undefined) result[key] = first;
        continue;
      }
      result[key] = values;
    }
    return result;
  }

  async buffer(): Promise<Buffer> {
    if (!this.bodyBufferPromise) {
      this.bodyBufferPromise = this.readAllBody();
    }
    return Buffer.from(await this.bodyBufferPromise);
  }

  async text(): Promise<string> {
    return (await this.buffer()).toString("utf8");
  }

  async json<T = unknown>(): Promise<T> {
    const raw = await this.text();
    if (!raw.trim()) {
      throw new HTTPError(400, "Expected JSON request body");
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new HTTPError(400, "Invalid JSON body");
    }
  }

  private get url(): URL {
    if (!this.urlCache) {
      const raw = this.raw.uri.toString("latin1");
      this.urlCache = new URL(raw, "http://local.request");
    }
    return this.urlCache;
  }

  private async readAllBody(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = await this.bodyReader.read();
      if (chunk.length === 0) break;
      total += chunk.length;
      if (total > this.maxBufferedBodyBytes) {
        throw new HTTPError(413, "Request body too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
}
