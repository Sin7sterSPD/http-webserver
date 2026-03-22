import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export const maxGzipFileBytes = 2 * 1024 * 1024;

export function acceptsGzip(enc: string | null | undefined): boolean {
  if (!enc) return false;
  return enc.toLowerCase().includes("gzip");
}

export function gzipFriendlyMime(mime: string): boolean {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base.startsWith("text/") ||
    base === "application/javascript" ||
    base === "application/json" ||
    base === "image/svg+xml"
  );
}

export async function gzipBuffer(buf: Buffer): Promise<Buffer> {
  return gzipAsync(buf);
}
