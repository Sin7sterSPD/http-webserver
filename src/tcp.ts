import * as net from "node:net";
import type { TCPConn } from "./http_types.js";

export function soInit(socket: net.Socket): TCPConn {
  const conn: TCPConn = { socket, err: null, ended: false, reader: null };

  socket.on("data", (data: Buffer) => {
    if (!conn.reader) return;
    conn.socket.pause();
    conn.reader.resolve(data);
    conn.reader = null;
  });

  socket.on("end", () => {
    conn.ended = true;
    if (conn.reader) {
      conn.reader.resolve(Buffer.from(""));
      conn.reader = null;
    }
  });

  socket.on("error", (err: Error) => {
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });

  return conn;
}

export function soRead(conn: TCPConn): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (conn.ended) return resolve(Buffer.from(""));
    if (conn.err) return reject(conn.err);
    conn.reader = { resolve, reject };
    conn.socket.resume();
  });
}

export function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.socket.write(data, (err?: Error | null) =>
      err ? reject(err) : resolve()
    );
  });
}
