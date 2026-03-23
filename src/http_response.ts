import type { HTTPRes, TCPConn } from "./http_types.js";
import { soWrite } from "./tcp.js";

function statusReason(code: number): string {
  const m: Record<number, string> = {
    101: "Switching Protocols",
    200: "OK",
    206: "Partial Content",
    304: "Not Modified",
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Payload Too Large",
    416: "Range Not Satisfiable",
    429: "Too Many Requests",
    500: "Internal Server Error",
  };
  return m[code] ?? "OK";
}

function hasHeader(headers: Buffer[], nameLower: string): boolean {
  for (const h of headers) {
    const line = h.toString("latin1");
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === nameLower) return true;
  }
  return false;
}

export function encodeHTTPResp(res: HTTPRes): Buffer {
  const lines: string[] = [];
  lines.push(`HTTP/1.1 ${res.code} ${statusReason(res.code)}`);
  for (const h of res.headers) {
    lines.push(h.toString("latin1"));
  }
  lines.push("\r\n");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

export async function writeHTTPResp(
  conn: TCPConn,
  res: HTTPRes
): Promise<void> {
  const chunked = res.chunked === true || res.body.length < 0;
  const noContentLength =
    res.code === 101 || res.code === 304 || chunked;

  if (chunked && !hasHeader(res.headers, "transfer-encoding")) {
    res.headers.push(Buffer.from("Transfer-Encoding: chunked"));
  }

  if (!noContentLength) {
    res.headers.push(Buffer.from(`Content-Length: ${res.body.length}`));
  }

  const header = encodeHTTPResp(res);
  await soWrite(conn, header);

  if (res.headOnly === true) return;

  if (chunked) {
    while (true) {
      const data = await res.body.read();
      if (data.length === 0) {
        await soWrite(conn, Buffer.from("0\r\n\r\n", "latin1"));
        break;
      }
      const hex = data.length.toString(16).toUpperCase();
      const prefix = Buffer.from(`${hex}\r\n`, "latin1");
      await soWrite(conn, prefix);
      await soWrite(conn, data);
      await soWrite(conn, Buffer.from("\r\n", "latin1"));
    }
    return;
  }

  while (true) {
    const data = await res.body.read();
    if (data.length === 0) break;
    await soWrite(conn, data);
  }
}
