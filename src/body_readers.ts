import fs from "node:fs/promises";
import type { BodyReader, DynBuf, TCPConn } from "./http_types.js";
import { bufPop, bufPush } from "./buffer.js";
import { soRead } from "./tcp.js";

export function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async () => {
      if (done) return Buffer.from("");
      done = true;
      return data;
    },
  };
}

/** For HEAD: advertise entity size without sending bytes. */
export function readerEmptyWithLength(entityLength: number): BodyReader {
  return {
    length: entityLength,
    read: async () => Buffer.from(""),
  };
}

export function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain === 0) return Buffer.from("");
      if (buf.length === 0) {
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) throw new Error("Unexpected EOF");
      }
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

export function readerFromChunks(chunks: Buffer[]): BodyReader {
  let i = 0;
  return {
    length: -1,
    read: async (): Promise<Buffer> => {
      if (i >= chunks.length) return Buffer.from("");
      const idx = i;
      i += 1;
      const c = chunks[idx];
      return c ?? Buffer.from("");
    },
  };
}

export function readerFromFile(
  filePath: string,
  start: number,
  byteLength: number
): BodyReader {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  let opened = false;
  let offset = start;
  let remain = byteLength;

  return {
    length: byteLength,
    read: async () => {
      if (remain <= 0) {
        if (fh) await fh.close().catch(() => {});
        fh = null;
        return Buffer.from("");
      }
      if (!opened) {
        fh = await fs.open(filePath, "r");
        opened = true;
      }
      const handle = fh;
      if (!handle) throw new Error("file reader: missing handle");
      const size = Math.min(64 * 1024, remain);
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, offset);
      const n = bytesRead ?? 0;
      offset += n;
      remain -= n;
      if (remain <= 0 && fh) {
        await fh.close().catch(() => {});
        fh = null;
      }
      return Buffer.from(buf.subarray(0, n));
    },
  };
}
