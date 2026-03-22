import crypto from "node:crypto";
import type { DynBuf, HTTPReq, HTTPRes, TCPConn } from "./http_types.js";
import { bufPop, bufPush } from "./buffer.js";
import { fieldGet } from "./http_parser.js";
import { readerFromMemory } from "./body_readers.js";
import { soRead, soWrite } from "./tcp.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function isWebSocketUpgrade(req: HTTPReq): boolean {
  if (req.method !== "GET") return false;
  const up = fieldGet(req.headers, "Upgrade")?.toString("latin1").toLowerCase();
  if (up !== "websocket") return false;
  const conn =
    fieldGet(req.headers, "Connection")?.toString("latin1").toLowerCase() ?? "";
  if (!conn.includes("upgrade")) return false;
  const ver = fieldGet(req.headers, "Sec-WebSocket-Version")?.toString("latin1");
  return ver === "13";
}

export function computeSecWebSocketAccept(secKey: string): string {
  return crypto
    .createHash("sha1")
    .update(secKey.trim() + WS_GUID)
    .digest("base64");
}

export function wsUpgradeResponse(accept: string): HTTPRes {
  return {
    code: 101,
    headers: [
      Buffer.from("Upgrade: websocket"),
      Buffer.from("Connection: Upgrade"),
      Buffer.from(`Sec-WebSocket-Accept: ${accept}`),
    ],
    body: readerFromMemory(Buffer.from("")),
  };
}

export function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const fin = 0x80;
  const head0 = Buffer.from([fin | (opcode & 0xf)]);
  const plen = payload.length;
  let lenBytes: Buffer;
  let b1: number;
  if (plen < 126) {
    b1 = plen;
    lenBytes = Buffer.from([b1]);
  } else if (plen < 65536) {
    b1 = 126;
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = b1;
    lenBytes.writeUInt16BE(plen, 1);
  } else {
    b1 = 127;
    lenBytes = Buffer.alloc(9);
    lenBytes[0] = b1;
    lenBytes.writeBigUInt64BE(BigInt(plen), 1);
  }
  return Buffer.concat([head0, lenBytes, payload]);
}

async function readAtLeast(conn: TCPConn, buf: DynBuf, n: number): Promise<void> {
  while (buf.length < n) {
    const d = await soRead(conn);
    if (d.length === 0) throw new Error("Unexpected EOF in WebSocket");
    bufPush(buf, d);
  }
}

function take(buf: DynBuf, n: number): Buffer {
  const out = Buffer.from(buf.data.subarray(0, n));
  bufPop(buf, n);
  return out;
}

async function readWsFrame(
  conn: TCPConn,
  buf: DynBuf
): Promise<{ opcode: number; payload: Buffer }> {
  await readAtLeast(conn, buf, 2);
  const b0 = buf.data[0]!;
  const b1 = buf.data[1]!;
  bufPop(buf, 2);
  const opcode = b0 & 0xf;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  if (len === 126) {
    await readAtLeast(conn, buf, 2);
    len = buf.data.readUInt16BE(0);
    bufPop(buf, 2);
  } else if (len === 127) {
    await readAtLeast(conn, buf, 8);
    const big = buf.data.readBigUInt64BE(0);
    bufPop(buf, 8);
    if (big > BigInt(16 * 1024 * 1024)) throw new Error("WS frame too large");
    len = Number(big);
  }
  let mask = Buffer.alloc(4);
  if (masked) {
    await readAtLeast(conn, buf, 4);
    mask = Buffer.from(take(buf, 4));
  }
  await readAtLeast(conn, buf, len);
  let payload = take(buf, len);
  if (masked) {
    for (let i = 0; i < payload.length; i++) {
      const mi = mask[i % 4];
      const bi = payload[i];
      if (mi === undefined || bi === undefined) continue;
      payload[i] = bi ^ mi;
    }
  }
  return { opcode, payload };
}

export async function runWebSocketSession(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  await soWrite(
    conn,
    encodeWsFrame(
      0x1,
      Buffer.from("Welcome! Send text; server echoes.\n", "utf8")
    )
  );

  while (true) {
    let frame: { opcode: number; payload: Buffer };
    try {
      frame = await readWsFrame(conn, buf);
    } catch {
      break;
    }
    const { opcode, payload } = frame;
    if (opcode === 0x8) {
      await soWrite(
        conn,
        encodeWsFrame(0x8, Buffer.alloc(0))
      ).catch(() => {});
      break;
    }
    if (opcode === 0x9) {
      await soWrite(conn, encodeWsFrame(0xa, payload)).catch(() => {});
      continue;
    }
    if (opcode === 0xa) continue;
    if (opcode === 0x1 || opcode === 0x2) {
      const label =
        opcode === 0x1 ? payload.toString("utf8") : `[binary ${payload.length}b]`;
      const reply = `Echo: ${label}\n`;
      await soWrite(conn, encodeWsFrame(0x1, Buffer.from(reply, "utf8"))).catch(
        () => {}
      );
      continue;
    }
  }
}
