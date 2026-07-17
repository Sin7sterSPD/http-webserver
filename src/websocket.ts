import crypto from "node:crypto";
import type { DynBuf, HTTPReq, HTTPRes, TCPConn } from "./http_types.js";
import type {
  WebSocketConnection,
  WebSocketRouteSession,
} from "./framework/types.js";
import { bufPop, bufPush } from "./buffer.js";
import { fieldGet } from "./http_parser.js";
import { readerFromMemory } from "./body_readers.js";
import { soRead, soWrite } from "./tcp.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB max frame
const WS_KEEPALIVE_INTERVAL_MS = 30000;
const WS_KEEPALIVE_TIMEOUT_MS = 10000;

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

export function wsUpgradeResponse(accept: string, protocol?: string): HTTPRes {
  const headers = [
    Buffer.from("Upgrade: websocket"),
    Buffer.from("Connection: Upgrade"),
    Buffer.from(`Sec-WebSocket-Accept: ${accept}`),
  ];
  if (protocol) {
    headers.push(Buffer.from(`Sec-WebSocket-Protocol: ${protocol}`));
  }
  return {
    code: 101,
    headers,
    body: readerFromMemory(Buffer.from("")),
  };
}

export function encodeWsFrame(
  opcode: number,
  payload: Buffer,
  opts?: { fin?: boolean; mask?: Buffer }
): Buffer {
  const fin = (opts?.fin ?? true) ? 0x80 : 0;
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

type WSFrame = {
  opcode: number;
  payload: Buffer;
  fin: boolean;
};

async function readWsFrame(conn: TCPConn, buf: DynBuf): Promise<WSFrame> {
  await readAtLeast(conn, buf, 2);
  const b0 = buf.data[0]!;
  const b1 = buf.data[1]!;
  bufPop(buf, 2);
  const opcode = b0 & 0xf;
  const fin = (b0 & 0x80) !== 0;
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
    if (big > BigInt(WS_MAX_FRAME_SIZE)) throw new Error("WS frame too large");
    len = Number(big);
  }
  if (len > WS_MAX_FRAME_SIZE) throw new Error("WS frame too large");
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
  return { opcode, payload, fin };
}

/** Read a complete WebSocket message, handling fragmentation. */
async function readWsMessage(
  conn: TCPConn,
  buf: DynBuf
): Promise<{ opcode: number; payload: Buffer } | null> {
  const fragments: Buffer[] = [];
  let messageOpcode = 0;

  while (true) {
    const frame = await readWsFrame(conn, buf);
    const { opcode, payload, fin } = frame;

    // Control frames can appear between data fragments — handle immediately
    if (opcode === 0x8) {
      return { opcode, payload };
    }
    if (opcode === 0x9) {
      return { opcode, payload };
    }
    if (opcode === 0xa) {
      return { opcode, payload };
    }

    if (opcode === 0x0) {
      // continuation
      fragments.push(payload);
    } else if (opcode === 0x1 || opcode === 0x2) {
      messageOpcode = opcode;
      fragments.push(payload);
    } else {
      throw new Error(`Unknown WS opcode: ${opcode}`);
    }

    if (fin) break;
  }

  const full = Buffer.concat(fragments);
  return { opcode: messageOpcode, payload: full };
}

function createWebSocketConnection(conn: TCPConn): WebSocketConnection {
  return {
    send: async (data) => {
      const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const opcode = typeof data === "string" ? 0x1 : 0x2;
      await soWrite(conn, encodeWsFrame(opcode, payload));
    },
    ping: async () => {
      await soWrite(conn, encodeWsFrame(0x9, Buffer.alloc(0)));
    },
    close: async () => {
      await soWrite(conn, encodeWsFrame(0x8, Buffer.alloc(0))).catch(() => {});
      conn.socket.end();
    },
  };
}

export async function runWebSocketSession(
  conn: TCPConn,
  session?: WebSocketRouteSession,
): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
  const ws = createWebSocketConnection(conn);
  let lastPong = Date.now();
  let closed = false;

  // Keepalive ping/pong
  const pingTimer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastPong > WS_KEEPALIVE_TIMEOUT_MS + WS_KEEPALIVE_INTERVAL_MS) {
      ws.close().catch(() => {});
      return;
    }
    ws.ping().catch(() => {});
  }, WS_KEEPALIVE_INTERVAL_MS);

  const cleanup = () => {
    closed = true;
    clearInterval(pingTimer);
  };

  try {
    if (session) {
      await session.open?.(ws);
    } else {
      await ws.send("Welcome! Send text; server echoes.\n");
    }

    while (!closed) {
      let msg: { opcode: number; payload: Buffer } | null;
      try {
        msg = await readWsMessage(conn, buf);
      } catch {
        break;
      }
      if (!msg) continue;

      const { opcode, payload } = msg;
      if (opcode === 0x8) {
        await soWrite(conn, encodeWsFrame(0x8, Buffer.alloc(0))).catch(() => {});
        break;
      }
      if (opcode === 0x9) {
        // ping — send pong
        await soWrite(conn, encodeWsFrame(0xa, payload)).catch(() => {});
        continue;
      }
      if (opcode === 0xa) {
        // pong
        lastPong = Date.now();
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        const message = opcode === 0x1 ? payload.toString("utf8") : payload;
        if (session) {
          await session.message?.(ws, message);
        } else {
          const label =
            typeof message === "string" ? message : `[binary ${message.length}b]`;
          await ws.send(`Echo: ${label}\n`).catch(() => {});
        }
        continue;
      }
    }

    await session?.close?.(ws);
  } finally {
    cleanup();
  }
}

/** Extract client-offered subprotocols from the request. */
export function getClientProtocols(req: HTTPReq): string[] {
  const raw = fieldGet(req.headers, "Sec-WebSocket-Protocol")?.toString("latin1");
  if (!raw) return [];
  return raw.split(",").map((p) => p.trim()).filter(Boolean);
}
