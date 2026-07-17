import fs from "node:fs/promises";
import type { BodyReader, DynBuf, TCPConn } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { bufPop, bufPush } from "./buffer.js";
import { soRead } from "./tcp.js";

const MAX_CHUNK_SIZE = 16 * 1024 * 1024; // 16 MB per chunk
const MAX_TOTAL_BODY_SIZE = 100 * 1024 * 1024; // 100 MB total

/** Read until we have at least `n` bytes in the buffer. */
async function readAtLeast(conn: TCPConn, buf: DynBuf, n: number): Promise<void> {
  while (buf.length < n) {
    const data = await soRead(conn);
    if (data.length === 0) throw new HTTPError(400, "Unexpected EOF reading body");
    bufPush(buf, data);
  }
}

/** Find a CRLF sequence in the buffer, return its index or -1. */
function findCRLF(buf: DynBuf): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf.data[i] === 0x0d && buf.data[i + 1] === 0x0a) return i;
  }
  return -1;
}

/** Read a line terminated by CRLF from the buffered connection. */
async function readLine(conn: TCPConn, buf: DynBuf): Promise<Buffer> {
  while (true) {
    const idx = findCRLF(buf);
    if (idx >= 0) {
      const line = Buffer.from(buf.data.subarray(0, idx));
      bufPop(buf, idx + 2); // remove line + \r\n
      return line;
    }
    const data = await soRead(conn);
    if (data.length === 0) throw new HTTPError(400, "Unexpected EOF reading chunked body");
    bufPush(buf, data);
  }
}

/** Consume exactly \r\n from the buffer. */
async function readCRLF(conn: TCPConn, buf: DynBuf): Promise<void> {
  await readAtLeast(conn, buf, 2);
  if (buf.data[0] !== 0x0d || buf.data[1] !== 0x0a) {
    throw new HTTPError(400, "Expected CRLF in chunked body");
  }
  bufPop(buf, 2);
}

/** Skip trailer headers after the final chunk. */
async function skipTrailers(conn: TCPConn, buf: DynBuf): Promise<void> {
  while (true) {
    const line = await readLine(conn, buf);
    if (line.length === 0) return; // empty line marks end of trailers
  }
}

export function readerFromChunkedConn(conn: TCPConn, buf: DynBuf): BodyReader {
  let done = false;
  let currentChunkRemain = 0;
  let inChunkData = false;
  let totalBytesRead = 0;

  const readChunk = async (): Promise<Buffer> => {
    if (done) return Buffer.from("");

    // Drain remaining chunk data
    if (inChunkData && currentChunkRemain > 0) {
      const avail = Math.min(buf.length, currentChunkRemain);
      if (avail === 0) {
        await readAtLeast(conn, buf, 1);
        return readChunk();
      }
      const out = Buffer.from(buf.data.subarray(0, avail));
      bufPop(buf, avail);
      currentChunkRemain -= avail;
      if (currentChunkRemain === 0) {
        inChunkData = false;
        await readCRLF(conn, buf);
      }
      totalBytesRead += out.length;
      if (totalBytesRead > MAX_TOTAL_BODY_SIZE) {
        throw new HTTPError(413, "Request body too large");
      }
      return out;
    }

    // Read next chunk size line
    if (!done && !inChunkData) {
      const line = await readLine(conn, buf);
      const sizeHex = line.toString("latin1").split(";")[0]?.trim() ?? "0";
      const size = parseInt(sizeHex, 16);
      if (isNaN(size)) throw new HTTPError(400, "Invalid chunk size");
      if (size > MAX_CHUNK_SIZE) throw new HTTPError(413, "Chunk too large");
      if (size === 0) {
        await skipTrailers(conn, buf);
        done = true;
        return Buffer.from("");
      }
      currentChunkRemain = size;
      inChunkData = true;
      return readChunk();
    }

    return Buffer.from("");
  };

  return {
    length: -1, // unknown total length
    read: readChunk,
  };
}

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
