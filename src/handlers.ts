import fs from "node:fs/promises";
import path from "node:path";
import type { BodyReader, HTTPReq, HTTPRes } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { fieldGet } from "./http_parser.js";
import {
  readerEmptyWithLength,
  readerFromChunks,
  readerFromMemory,
} from "./body_readers.js";
import {
  mimeFromPath,
  resolveSafe,
  serveStatic,
  urlPathname,
} from "./file_server.js";
import {
  computeSecWebSocketAccept,
  isWebSocketUpgrade,
  wsUpgradeResponse,
} from "./websocket.js";
import { Router } from "./router.js";

const FILES_DIR = path.join(process.cwd(), "files");

const router = new Router();

router.get("/stream", async () => {
  const chunks = [
    Buffer.from("This is the first chunk.\n", "utf8"),
    Buffer.from("And the second chunk.\n", "utf8"),
  ];
  return {
    code: 200,
    headers: [
      Buffer.from("Server: http-web-server"),
      Buffer.from("Content-Type: text/plain; charset=utf-8"),
    ],
    body: readerFromChunks(chunks),
    chunked: true,
  };
});

router.head("/echo", async () => ({
  code: 200,
  headers: [Buffer.from("Server: http-web-server")],
  body: readerEmptyWithLength(0),
  headOnly: true,
}));

router.get("/echo", async (_req, body) => ({
  code: 200,
  headers: [Buffer.from("Server: http-web-server")],
  body,
}));

router.post("/echo", async (_req, body) => ({
  code: 200,
  headers: [Buffer.from("Server: http-web-server")],
  body,
}));

router.get("/api/v1/health", async () => ({
  code: 200,
  headers: [
    Buffer.from("Server: http-web-server"),
    Buffer.from("Content-Type: application/json; charset=utf-8"),
  ],
  body: readerFromMemory(
    Buffer.from(JSON.stringify({ status: "ok" }), "utf8")
  ),
}));

router.get("/users/:id", async (_req, _body, params) => ({
  code: 200,
  headers: [
    Buffer.from("Server: http-web-server"),
    Buffer.from("Content-Type: text/plain; charset=utf-8"),
  ],
  body: readerFromMemory(Buffer.from(`${params.id ?? ""}\n`, "utf8")),
}));

router.get("/files/*", async (_req, _body, params) => {
  const rel = params.wildcard ?? "";
  let filePath: string;
  try {
    filePath = resolveSafe(FILES_DIR, rel);
  } catch (err) {
    if (err instanceof HTTPError) throw err;
    throw new HTTPError(404, "Not Found");
  }
  const buf = await fs.readFile(filePath).catch(() => null);
  if (!buf) throw new HTTPError(404, "Not Found");
  return {
    code: 200,
    headers: [
      Buffer.from("Server: http-web-server"),
      Buffer.from(`Content-Type: ${mimeFromPath(filePath)}`),
    ],
    body: readerFromMemory(buf),
  };
});

router.post("/upload", async (_req, body) => {
  let total = 0;
  while (true) {
    const chunk = await body.read();
    if (chunk.length === 0) break;
    total += chunk.length;
  }
  const msg = `received ${total} bytes\n`;
  return {
    code: 200,
    headers: [
      Buffer.from("Server: http-web-server"),
      Buffer.from("Content-Type: text/plain; charset=utf-8"),
    ],
    body: readerFromMemory(Buffer.from(msg, "utf8")),
  };
});

router.get("/*", async (req) => serveStatic(req, FILES_DIR));
router.head("/*", async (req) => serveStatic(req, FILES_DIR));

export async function handleReq(
  req: HTTPReq,
  body: BodyReader
): Promise<HTTPRes> {
  const pathname = urlPathname(req.uri);

  if (isWebSocketUpgrade(req)) {
    if (pathname !== "/chat" && pathname !== "/ws") {
      throw new HTTPError(404, "Not Found");
    }
    const key = fieldGet(req.headers, "Sec-WebSocket-Key")?.toString("latin1");
    if (!key) throw new HTTPError(400, "Missing Sec-WebSocket-Key");
    return wsUpgradeResponse(computeSecWebSocketAccept(key));
  }

  const hit = router.match(req.method, pathname);
  if (!hit) {
    throw new HTTPError(404, "Not Found");
  }
  return hit.handler(req, body, hit.params);
}
