import * as net from "node:net";
import type { BodyReader, DynBuf, HTTPReq, HTTPRes, TCPConn } from "../http_types.js";
import { HTTPError } from "../http_types.js";
import { bufPush } from "../buffer.js";
import { readerFromMemory } from "../body_readers.js";
import { cutMessage, fieldGet, readerFromReq } from "../http_parser.js";
import { writeHTTPResp } from "../http_response.js";
import { normalizeClientIp } from "../rate_limit.js";
import { Router } from "../router.js";
import type { RouteHandler, RouteParams } from "../router.js";
import { soInit, soRead } from "../tcp.js";
import { urlPathname } from "../file_server.js";
import {
  computeSecWebSocketAccept,
  isWebSocketUpgrade,
  runWebSocketSession,
  wsUpgradeResponse,
} from "../websocket.js";
import { Context } from "./context.js";
import type {
  AppDispatchResult,
  AppErrorHandler,
  AppHandler,
  DispatchOptions,
  WebSocketRouteHandler,
} from "./types.js";

export type ListenOptions = {
  host?: string;
  port?: number;
  printRoutes?: boolean;
};

export type RouteInfo = {
  method: "GET" | "POST" | "HEAD" | "WS";
  path: string;
};

function isHTTPRes(value: unknown): value is HTTPRes {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "headers" in value &&
    "body" in value
  );
}

function compose(handlers: AppHandler[]): AppHandler {
  return async (c, _next) => {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      const handler = handlers[i];
      if (!handler) return;
      const result = await handler(c, () => dispatch(i + 1));
      if (isHTTPRes(result)) {
        c.setResponse(result);
      }
    };

    await dispatch(0);
  };
}

function normalizeHandlers(handlers: AppHandler[]): AppHandler[] {
  if (handlers.length === 0) {
    throw new Error("Route requires at least one handler");
  }
  return handlers;
}

function joinPaths(prefix: string, path: string): string {
  const left = prefix.trim();
  const right = path.trim();
  if (!left || left === "/") return right.startsWith("/") ? right : `/${right}`;
  if (!right || right === "/") return left.startsWith("/") ? left : `/${left}`;
  const a = left.replace(/\/+$/, "");
  const b = right.replace(/^\/+/, "");
  return `${a.startsWith("/") ? a : `/${a}`}/${b}`;
}

type StoredHttpRoute = RouteHandler & { appHandlers: AppHandler[] };
type StoredWsRoute = RouteHandler & { wsHandler: WebSocketRouteHandler };

function storedHttpRoute(handlers: AppHandler[]): StoredHttpRoute {
  const route = (async () => {
    throw new Error("Stored HTTP route should only be matched by App.dispatch");
  }) as unknown as StoredHttpRoute;
  route.appHandlers = handlers;
  return route;
}

function storedWsRoute(handler: WebSocketRouteHandler): StoredWsRoute {
  const route = (async () => {
    throw new Error("Stored WebSocket route should only be matched by App.dispatch");
  }) as unknown as StoredWsRoute;
  route.wsHandler = handler;
  return route;
}

export class RouteGroup {
  private readonly middleware: AppHandler[] = [];

  constructor(
    private readonly app: App,
    private readonly prefix: string,
    middleware: AppHandler[] = [],
  ) {
    this.middleware.push(...middleware);
  }

  use(handler: AppHandler): this {
    this.middleware.push(handler);
    return this;
  }

  get(pattern: string, ...handlers: AppHandler[]): this {
    this.app.addRoute(
      "GET",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers),
    );
    return this;
  }

  post(pattern: string, ...handlers: AppHandler[]): this {
    this.app.addRoute(
      "POST",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers),
    );
    return this;
  }

  head(pattern: string, ...handlers: AppHandler[]): this {
    this.app.addRoute(
      "HEAD",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers),
    );
    return this;
  }

  ws(pattern: string, handler: WebSocketRouteHandler): this {
    this.app.addWebSocketRoute(joinPaths(this.prefix, pattern), handler);
    return this;
  }

  group(prefix: string): RouteGroup {
    return new RouteGroup(
      this.app,
      joinPaths(this.prefix, prefix),
      this.middleware.slice(),
    );
  }
}

export class App {
  private readonly router = new Router();
  private readonly wsRouter = new Router();
  private readonly middleware: AppHandler[] = [];
  private readonly routeTable: RouteInfo[] = [];
  private errorHandler: AppErrorHandler = (err, c) => {
    if (err instanceof HTTPError) {
      return c.status(err.code).text(`${err.message}\n`);
    }
    console.error("Unhandled application error:", err);
    return c.status(500).json({ error: "Internal Server Error" });
  };

  use(handler: AppHandler): this {
    this.middleware.push(handler);
    return this;
  }

  get(pattern: string, ...handlers: AppHandler[]): this {
    return this.addRoute("GET", pattern, ...normalizeHandlers(handlers));
  }

  post(pattern: string, ...handlers: AppHandler[]): this {
    return this.addRoute("POST", pattern, ...normalizeHandlers(handlers));
  }

  head(pattern: string, ...handlers: AppHandler[]): this {
    return this.addRoute("HEAD", pattern, ...normalizeHandlers(handlers));
  }

  group(prefix: string): RouteGroup {
    return new RouteGroup(this, prefix);
  }

  onError(handler: AppErrorHandler): this {
    this.errorHandler = handler;
    return this;
  }

  ws(pattern: string, handler: WebSocketRouteHandler): this {
    return this.addWebSocketRoute(pattern, handler);
  }

  routes(): RouteInfo[] {
    return this.routeTable.map((route) => ({ ...route }));
  }

  listen(options: number | ListenOptions = {}): net.Server {
    const opts: ListenOptions =
      typeof options === "number" ? { port: options } : options;
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? (Number(process.env.PORT) || 1234);
    const printRoutes = opts.printRoutes ?? true;

    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
      void this.handleSocket(socket);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `Port ${port} is already in use. Use a different port or stop the existing server.`,
        );
      } else if (err.code === "EACCES") {
        console.error(`Permission denied binding to ${host}:${port} (EACCES).`);
      } else {
        console.error("Server error:", err);
      }
      process.exit(1);
    });

    server.listen({ host, port }, () => {
      const base = `http://${host}:${port}`;
      console.log(`HTTP framework server at ${base}`);
      if (printRoutes) this.printRoutes();
    });

    return server;
  }

  async dispatch(
    req: HTTPReq,
    body: BodyReader,
    opts: DispatchOptions,
  ): Promise<AppDispatchResult> {
    const pathname = urlPathname(req.uri);
    const ws = this.matchWebSocket(req, pathname);
    const http = ws ?? this.router.match(req.method, pathname);

    if (!http) {
      const c = new Context(req, body, {}, opts.clientIp);
      return { response: c.status(404).text("Not Found\n") };
    }

    const c = new Context(req, body, http.params, opts.clientIp);

    try {
      if (ws) {
        const accept = this.webSocketAccept(req);
        const wsHandler = ws.handler;
        c.setWebSocketSession({
          open: (socket) => wsHandler.open?.(socket, c),
          message: (socket, message) => wsHandler.message?.(socket, message, c),
          close: (socket) => wsHandler.close?.(socket, c),
        });
        const websocket = c.getWebSocketSession();
        const result: AppDispatchResult = { response: wsUpgradeResponse(accept) };
        if (websocket) result.websocket = websocket;
        return result;
      }

      const route = http.handler as StoredHttpRoute;
      const chain = compose([...this.middleware, ...route.appHandlers]);
      await chain(c, async () => {});

      if (!c.response) {
        throw new Error(`Handler for ${req.method} ${pathname} did not return a response`);
      }

      const result: AppDispatchResult = { response: c.response };
      const websocket = c.getWebSocketSession();
      if (websocket) result.websocket = websocket;
      return result;
    } catch (err) {
      const response = await this.errorHandler(err, c);
      return { response };
    }
  }

  addRoute(method: "GET" | "POST" | "HEAD", pattern: string, ...handlers: AppHandler[]): this {
    this.router.add(method, pattern, storedHttpRoute(handlers));
    this.routeTable.push({ method, path: pattern });
    return this;
  }

  addWebSocketRoute(pattern: string, handler: WebSocketRouteHandler): this {
    this.wsRouter.get(pattern, storedWsRoute(handler));
    this.routeTable.push({ method: "WS", path: pattern });
    return this;
  }

  private async handleSocket(socket: net.Socket): Promise<void> {
    const conn = soInit(socket);
    try {
      await this.serveClient(conn);
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

  private async serveClient(conn: TCPConn): Promise<void> {
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
      const result = await this.dispatch(msg, reqBody, {
        clientIp: normalizeClientIp(conn.socket.remoteAddress),
      });
      await writeHTTPResp(conn, result.response);

      if (result.response.code === 101) {
        await runWebSocketSession(conn, result.websocket);
        return;
      }

      if (msg.version === "1.0") return;

      while ((await reqBody.read()).length > 0) {}
    }
  }

  private matchWebSocket(
    req: HTTPReq,
    pathname: string,
  ): { handler: WebSocketRouteHandler; params: RouteParams } | null {
    if (!isWebSocketUpgrade(req)) return null;
    const matched = this.wsRouter.match("GET", pathname);
    if (!matched) return null;
    const route = matched.handler as StoredWsRoute;
    return { handler: route.wsHandler, params: matched.params };
  }

  private webSocketAccept(req: HTTPReq): string {
    const key = fieldGet(req.headers, "Sec-WebSocket-Key")?.toString("latin1");
    if (!key) throw new HTTPError(400, "Missing Sec-WebSocket-Key");
    return computeSecWebSocketAccept(key);
  }

  private printRoutes(): void {
    if (this.routeTable.length === 0) return;
    console.log("Routes:");
    for (const route of this.routeTable) {
      console.log(`  ${route.method.padEnd(5)} ${route.path}`);
    }
  }
}
