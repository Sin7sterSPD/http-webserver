import fs from "node:fs/promises";
import path from "node:path";
import type { BodyReader, HTTPReq, HTTPRes } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { fieldGet } from "./http_parser.js";
import { etagFromStat, ifNoneMatchMatches } from "./cache.js";
import {
  acceptsGzip,
  gzipBuffer,
  gzipFriendlyMime,
  maxGzipFileBytes,
} from "./compression.js";
import {
  readerEmptyWithLength,
  readerFromFile,
  readerFromMemory,
} from "./body_readers.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export function urlPathname(uri: Buffer): string {
  const raw = uri.toString("latin1");
  const noQuery = raw.split("?", 1)[0] ?? raw;
  let p = noQuery.split("#", 1)[0] ?? noQuery;
  if (!p.startsWith("/")) p = "/" + p;
  try {
    p = decodeURIComponent(p);
  } catch {
    throw new HTTPError(400, "Bad URI encoding");
  }
  return path.posix.normalize(p);
}

function resolveSafe(filesRoot: string, urlPath: string): string {
  const rel = urlPath.replace(/^\/+/, "");
  const candidate = path.resolve(filesRoot, rel);
  const root = path.resolve(filesRoot);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new HTTPError(403, "Forbidden");
  }
  return candidate;
}

export function parseSingleRange(
  rangeSpec: string,
  fileSize: number
): { start: number; end: number } | "unsatisfiable" {
  const m = /^(\d*)-(\d*)$/.exec(rangeSpec.trim());
  if (!m) return "unsatisfiable";
  const a = m[1] ?? "";
  const b = m[2] ?? "";
  if (a === "" && b !== "") {
    const suffixLen = parseInt(b, 10);
    if (isNaN(suffixLen) || suffixLen <= 0) return "unsatisfiable";
    const start = Math.max(0, fileSize - suffixLen);
    return { start, end: fileSize - 1 };
  }
  if (a !== "" && b === "") {
    const start = parseInt(a, 10);
    if (isNaN(start) || start >= fileSize) return "unsatisfiable";
    return { start, end: fileSize - 1 };
  }
  if (a !== "" && b !== "") {
    const start = parseInt(a, 10);
    const end = parseInt(b, 10);
    if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
      return "unsatisfiable";
    }
    return { start, end: Math.min(end, fileSize - 1) };
  }
  return "unsatisfiable";
}

function rangeValueFromHeader(rangeHeader: string): string | null {
  const s = rangeHeader.trim();
  if (!s.toLowerCase().startsWith("bytes=")) return null;
  const rest = s.slice(6).trim();
  const comma = rest.indexOf(",");
  const first = (comma >= 0 ? rest.slice(0, comma) : rest).trim();
  return first.length ? first : null;
}

export async function serveStatic(
  req: HTTPReq,
  filesRoot: string
): Promise<HTTPRes> {
  let urlPath = urlPathname(req.uri);
  if (urlPath === "/") urlPath = "/index.html";

  let filePath = resolveSafe(filesRoot, urlPath);
  let st = await fs.stat(filePath).catch(() => null);
  if (st?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    st = await fs.stat(filePath).catch(() => null);
  }
  if (!st?.isFile()) {
    throw new HTTPError(404, "Not Found");
  }

  const etag = etagFromStat(st);
  const ifNone = fieldGet(req.headers, "If-None-Match")?.toString("latin1") ?? null;
  if (ifNoneMatchMatches(ifNone, etag)) {
    return {
      code: 304,
      headers: [
        Buffer.from("Server: http-web-server"),
        Buffer.from(`ETag: ${etag}`),
        Buffer.from(`Last-Modified: ${st.mtime.toUTCString()}`),
      ],
      body: readerFromMemory(Buffer.from("")),
    };
  }

  const fileSize = st.size;
  const rangeH = fieldGet(req.headers, "Range")?.toString("latin1") ?? null;
  const rangeSpec = rangeH ? rangeValueFromHeader(rangeH) : null;

  let start = 0;
  let end = fileSize - 1;
  let status = 200;
  const headers: Buffer[] = [
    Buffer.from("Server: http-web-server"),
    Buffer.from(`ETag: ${etag}`),
    Buffer.from(`Last-Modified: ${st.mtime.toUTCString()}`),
  ];

  const mime = mimeFromPath(filePath);
  headers.push(Buffer.from(`Content-Type: ${mime}`));

  const enc = fieldGet(req.headers, "Accept-Encoding")?.toString("latin1");
  const wantGzip =
    (req.method === "GET" || req.method === "HEAD") &&
    acceptsGzip(enc) &&
    gzipFriendlyMime(mime) &&
    !rangeSpec &&
    fileSize <= maxGzipFileBytes;

  if (rangeSpec) {
    const pr = parseSingleRange(rangeSpec, fileSize);
    if (pr === "unsatisfiable") {
      return {
        code: 416,
        headers: [
          Buffer.from("Server: http-web-server"),
          Buffer.from(`Content-Range: bytes */${fileSize}`),
        ],
        body: readerFromMemory(Buffer.from("Range Not Satisfiable\n")),
      };
    }
    start = pr.start;
    end = pr.end;
    status = 206;
    const sliceLen = end - start + 1;
    headers.push(
      Buffer.from(`Content-Range: bytes ${start}-${end}/${fileSize}`)
    );
    const body: BodyReader = readerFromFile(filePath, start, sliceLen);
    if (req.method === "HEAD") {
      return {
        code: status,
        headers,
        body: readerEmptyWithLength(sliceLen),
        headOnly: true,
      };
    }
    return { code: status, headers, body };
  }

  if (wantGzip) {
    const raw = await fs.readFile(filePath);
    const gz = await gzipBuffer(raw);
    headers.push(Buffer.from("Content-Encoding: gzip"));
    headers.push(Buffer.from("Vary: Accept-Encoding"));
    const body = readerFromMemory(gz);
    if (req.method === "HEAD") {
      return {
        code: 200,
        headers,
        body: readerEmptyWithLength(gz.length),
        headOnly: true,
      };
    }
    return { code: 200, headers, body };
  }

  const body: BodyReader = readerFromFile(filePath, 0, fileSize);
  if (req.method === "HEAD") {
    return {
      code: 200,
      headers,
      body: readerEmptyWithLength(fileSize),
      headOnly: true,
    };
  }
  return { code: status, headers, body };
}
