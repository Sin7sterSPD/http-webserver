import path from "node:path";
import type { BodyReader, HTTPReq, HTTPRes } from "./http_types.js";
import { HTTPError } from "./http_types.js";
import { fieldGet } from "./http_parser.js";
import {
  readerEmptyWithLength,
  readerFromChunks,
} from "./body_readers.js";
import { serveStatic, urlPathname } from "./file_server.js";
import {
  computeSecWebSocketAccept,
  isWebSocketUpgrade,
  wsUpgradeResponse,
} from "./websocket.js";

const FILES_DIR = path.join(process.cwd(), "files");

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

  if (req.method === "GET" && pathname === "/stream") {
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
  }

  if (pathname === "/echo") {
    if (req.method === "HEAD") {
      return {
        code: 200,
        headers: [Buffer.from("Server: http-web-server")],
        body: readerEmptyWithLength(0),
        headOnly: true,
      };
    }
    if (req.method === "POST" || req.method === "GET") {
      return {
        code: 200,
        headers: [Buffer.from("Server: http-web-server")],
        body,
      };
    }
    throw new HTTPError(405, "Method Not Allowed");
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, FILES_DIR);
  }

  throw new HTTPError(405, "Method Not Allowed");
}
