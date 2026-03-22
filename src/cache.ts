import type { Stats } from "node:fs";
import crypto from "node:crypto";

export function etagFromStat(stat: Stats): string {
  const basis = `${stat.dev}-${stat.ino}-${stat.size}-${Number(stat.mtimeMs)}`;
  const h = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
  return `"${h}"`;
}

export function ifNoneMatchMatches(
  ifNoneMatch: string | null,
  etag: string
): boolean {
  if (!ifNoneMatch) return false;
  const v = ifNoneMatch.trim();
  if (v === "*") return true;
  for (const part of v.split(",")) {
    let t = part.trim();
    if (t.startsWith("W/")) t = t.slice(2).trim();
    if (t === etag) return true;
  }
  return false;
}
