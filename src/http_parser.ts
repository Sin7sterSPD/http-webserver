import type { BodyReader, DynBuf, HTTPReq, TCPConn } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { bufPop } from "./buffer.js";
import {
  readerFromConnLength,
  readerFromMemory,
} from "./body_readers.js";

export const kMaxHeaderLen = 8 * 1024;

export function cutMessage(buf: DynBuf): HTTPReq | null {
  const idx = buf.data.subarray(0, buf.length).indexOf("\r\n\r\n");
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen)
      throw new HTTPError(413, "Header too large");
    return null;
  }

  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function splitLines(data: Buffer): Buffer[] {
  return data
    .toString("latin1")
    .split("\r\n")
    .map((l) => Buffer.from(l, "latin1"));
}

function parseRequestLine(line: Buffer): [string, Buffer, string] {
  const parts = line.toString("latin1").split(" ");
  if (parts.length !== 3) throw new HTTPError(400, "Bad request line");
  const [method, rawUri, protocol] = parts as [string, string, string];
  if (!protocol.startsWith("HTTP/")) throw new HTTPError(400, "Bad version");
  const version = protocol.split("/", 2)[1];
  if (!version) throw new HTTPError(400, "Bad version");
  return [method, Buffer.from(rawUri, "latin1"), version];
}

function validateHeader(h: Buffer): boolean {
  if (h.length === 0) return true;
  return h.includes(":".charCodeAt(0));
}

function parseHTTPReq(data: Buffer): HTTPReq {
  const lines = splitLines(data);
  const requestLine = lines[0];
  if (!requestLine) throw new HTTPError(400, "Missing request line");
  const [method, uri, version] = parseRequestLine(requestLine);
  const headers: Buffer[] = [];
  for (const line of lines.slice(1, -1)) {
    const h = Buffer.from(line);
    if (h.length === 0) continue;
    if (!validateHeader(h)) throw new HTTPError(400, "Invalid header field");
    headers.push(h);
  }
  return { method, uri, version, headers };
}

export function fieldGet(headers: Buffer[], key: string): Buffer | null {
  const lowerKey = key.toLowerCase();
  for (const h of headers) {
    const line = h.toString("latin1");
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (name.toLowerCase() === lowerKey) {
      const value = line.slice(idx + 1).trim();
      return Buffer.from(value, "latin1");
    }
  }
  return null;
}

function headerValueIncludes(h: Buffer | null, token: string): boolean {
  if (!h) return false;
  const v = h.toString("latin1").toLowerCase();
  return v.split(",").some((part) => part.trim() === token);
}

export function readerFromReq(
  conn: TCPConn,
  buf: DynBuf,
  req: HTTPReq
): BodyReader {
  const contentLen = fieldGet(req.headers, "Content-Length");
  const te = fieldGet(req.headers, "Transfer-Encoding");
  const chunked = headerValueIncludes(te, "chunked");
  const bodyAllowed = !(req.method === "GET" || req.method === "HEAD");

  if (!bodyAllowed) return readerFromMemory(Buffer.from(""));

  if (contentLen) {
    const bodyLen = parseInt(contentLen.toString("latin1"), 10);
    if (isNaN(bodyLen)) throw new HTTPError(400, "Bad Content-Length");
    return readerFromConnLength(conn, buf, bodyLen);
  }

  if (chunked) {
    return readerFromMemory(Buffer.from(""));
  }

  return readerFromMemory(Buffer.from(""));
}
