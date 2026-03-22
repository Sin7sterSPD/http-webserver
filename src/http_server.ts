import * as net from "node:net";
import type { DynBuf, HTTPRes, TCPConn } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { bufPush } from "./buffer.js";
import { readerFromMemory } from "./body_readers.js";
import { cutMessage, readerFromReq } from "./http_parser.js";
import { writeHTTPResp } from "./http_response.js";
import { handleReq } from "./handlers.js";
import { soInit, soRead } from "./tcp.js";
import { runWebSocketSession } from "./websocket.js";

async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };

  while (true) {
    const msg = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      if (data.length === 0 && buf.length === 0) return;
      if (data.length === 0) throw new HTTPError(400, "Unexpected EOF");
      continue;
    }

    const reqBody = readerFromReq(conn, buf, msg);
    const res = await handleReq(msg, reqBody);
    await writeHTTPResp(conn, res);

    if (res.code === 101) {
      await runWebSocketSession(conn);
      return;
    }

    if (msg.version === "1.0") return;

    while ((await reqBody.read()).length > 0) {}
  }
}

async function newConn(socket: net.Socket): Promise<void> {
  const conn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (err) {
    console.error("exception:", err);
    if (err instanceof HTTPError) {
      const resp: HTTPRes = {
        code: err.code,
        headers: [],
        body: readerFromMemory(Buffer.from(err.message + "\n")),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch {
        /* ignore */
      }
    }
  } finally {
    socket.destroy();
  }
}

const host = "127.0.0.1";
const port = Number(process.env.PORT) || 1234;

const server = net.createServer({ pauseOnConnect: true }, newConn);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use (another server may be running).\n` +
        `  Stop it: close the other terminal or run  taskkill /PID <pid> /F  (Windows)\n` +
        `  Or use a different port:  PORT=8080 npm run serve  (Git Bash)  or  set PORT=8080&& npm run serve  (cmd)`
    );
  } else if (err.code === "EACCES") {
    console.error(
      `Permission denied binding to ${host}:${port} (EACCES).\n` +
        `  On Windows this often means the port is in an *excluded range* (Hyper-V, WSL, Docker).\n` +
        `  Check:  netsh interface ipv4 show excludedportrange protocol=tcp\n` +
        `  Try a port outside those ranges, e.g.  PORT=8080 npm run serve  or  PORT=9000 npm run serve`
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});

server.listen({ host, port }, () => {
  const base = `http://${host}:${port}`;
  console.log(`HTTP server at ${base}`);
  console.log(`  Static files: ./files (try /index.html)`);
  console.log(`  WebSocket:    ws://${host}:${port}/chat or /ws`);
  console.log("  Chunked demo: GET /stream");
});
