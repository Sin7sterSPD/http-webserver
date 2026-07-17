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
import { configureSocket, soInit, soRead } from "../tcp.js";
import { urlPathname } from "../file_server.js";
import {
  computeSecWebSocketAccept,
  getClientProtocols,
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
  ParamsRecord,
  Plugin,
  WebSocketRouteHandler,
} from "./types.js";

export type ListenOptions = {
  host?: string;
  port?: number;
  printRoutes?: boolean;
  /** Max concurrent TCP connections. Default 1000. */
  maxConnections?: number;
  /** Socket idle timeout in ms. Default 30000. */
  idleTimeoutMs?: number;
  /** Max requests per keep-alive connection. Default 1000. */
  maxRequestsPerConnection?: number;
  /** Per-request timeout in ms. Default 30000. */
  requestTimeoutMs?: number;
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
    private readonly rootApp: App,
    private readonly prefix: string,
    middleware: AppHandler[] = [],
  ) {
    this.middleware.push(...middleware);
  }

  use(handler: AppHandler): this {
    this.middleware.push(handler);
    return this;
  }

  get<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    this.rootApp.addRoute(
      "GET",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers as AppHandler[]),
    );
    return this;
  }

  post<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    this.rootApp.addRoute(
      "POST",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers as AppHandler[]),
    );
    return this;
  }

  head<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    this.rootApp.addRoute(
      "HEAD",
      joinPaths(this.prefix, pattern),
      ...this.middleware,
      ...normalizeHandlers(handlers as AppHandler[]),
    );
    return this;
  }

  ws(pattern: string, handler: WebSocketRouteHandler): this {
    this.rootApp.addWebSocketRoute(joinPaths(this.prefix, pattern), handler);
    return this;
  }

  group(prefix: string): RouteGroup {
    return new RouteGroup(
      this.rootApp,
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
  private activeConnections = 0;
  private errorHandler: AppErrorHandler = (err, c) => {
    const isDev = process.env.NODE_ENV === "development";
    if (err instanceof HTTPError) {
      return c.status(err.code).json({
        error: err.message,
        ...(isDev && { stack: err.stack }),
      });
    }
    console.error("Unhandled application error:", err);
    return c.status(500).json({
      error: "Internal Server Error",
      ...(isDev && { detail: String(err), stack: (err as Error).stack }),
    });
  };

  use(handler: AppHandler): this {
    this.middleware.push(handler);
    return this;
  }

  get<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    return this.addRoute("GET", pattern, ...normalizeHandlers(handlers as AppHandler[]));
  }

  post<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    return this.addRoute("POST", pattern, ...normalizeHandlers(handlers as AppHandler[]));
  }

  head<Path extends string>(pattern: Path, ...handlers: AppHandler<Path>[]): this {
    return this.addRoute("HEAD", pattern, ...normalizeHandlers(handlers as AppHandler[]));
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

  /** Install a plugin into this app. */
  plugin(p: Plugin): this {
    p.install(this);
    return this;
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
    const maxConnections = opts.maxConnections ?? 1000;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 30000;
    const maxRequestsPerConnection = opts.maxRequestsPerConnection ?? 1000;
    const requestTimeoutMs = opts.requestTimeoutMs ?? 30000;

    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
      // Connection limit
      if (this.activeConnections >= maxConnections) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.activeConnections++;
      socket.on("close", () => {
        this.activeConnections--;
      });

      configureSocket(socket, { idleTimeoutMs });
      socket.on("timeout", () => {
        socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
        socket.destroy();
      });

      void this.handleSocket(socket, { maxRequestsPerConnection, requestTimeoutMs });
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
        // Subprotocol negotiation
        let negotiatedProtocol: string | undefined;
        const clientProtocols = getClientProtocols(req);
        if (wsHandler.protocols && wsHandler.protocols.length > 0) {
          if (wsHandler.negotiate) {
            negotiatedProtocol = wsHandler.negotiate(clientProtocols);
          } else if (clientProtocols.length > 0) {
            negotiatedProtocol = clientProtocols.find((p) => wsHandler.protocols!.includes(p));
          }
          if (!negotiatedProtocol && clientProtocols.length > 0) {
            throw new HTTPError(400, "No supported WebSocket subprotocol");
          }
        }
        c.setWebSocketSession({
          open: (socket) => wsHandler.open?.(socket, c),
          message: (socket, message) => wsHandler.message?.(socket, message, c),
          close: (socket) => wsHandler.close?.(socket, c),
        });
        const websocket = c.getWebSocketSession();
        const result: AppDispatchResult = { response: wsUpgradeResponse(accept, negotiatedProtocol) };
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

  private async handleSocket(
    socket: net.Socket,
    opts: { maxRequestsPerConnection: number; requestTimeoutMs: number },
  ): Promise<void> {
    const conn = soInit(socket);
    try {
      await this.serveClient(conn, opts);
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

  private async serveClient(
    conn: TCPConn,
    opts: { maxRequestsPerConnection: number; requestTimeoutMs: number },
  ): Promise<void> {
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
    let requestCount = 0;

    while (true) {
      requestCount++;
      const msg = cutMessage(buf);
      if (!msg) {
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0 && buf.length === 0) return;
        if (data.length === 0) throw new HTTPError(400, "Unexpected EOF");
        continue;
      }

      const reqBody = readerFromReq(conn, buf, msg);
      const result = await this.dispatchWithTimeout(msg, reqBody, {
        clientIp: normalizeClientIp(conn.socket.remoteAddress),
      }, opts.requestTimeoutMs);
      await writeHTTPResp(conn, result.response);

      if (result.response.code === 101) {
        await runWebSocketSession(conn, result.websocket);
        return;
      }

      // HTTP/1.0 or Connection: close → close after this response
      const connHeader = fieldGet(msg.headers, "Connection")?.toString("latin1").toLowerCase();
      const shouldClose = msg.version === "1.0" || connHeader === "close";

      // Drain any unread body so the next request starts clean
      while ((await reqBody.read()).length > 0) {}

      if (shouldClose || requestCount >= opts.maxRequestsPerConnection) {
        return;
      }
    }
  }

  private async dispatchWithTimeout(
    req: HTTPReq,
    body: BodyReader,
    opts: DispatchOptions,
    timeoutMs: number,
  ): Promise<AppDispatchResult> {
    return Promise.race([
      this.dispatch(req, body, opts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new HTTPError(408, "Request Timeout")), timeoutMs)
      ),
    ]);
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
