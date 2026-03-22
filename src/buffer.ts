import type { DynBuf } from "./http_types.js";

export function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    let cap = Math.max(buf.data.length, 32);
    while (cap < newLen) cap *= 2;
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0, buf.length);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length);
  buf.length = newLen;
}

export function bufPop(buf: DynBuf, len: number): void {
  buf.data.copyWithin(0, len, buf.length);
  buf.length -= len;
}
