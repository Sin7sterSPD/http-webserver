import type { HTTPRes } from "../http_types.js";
import type { Context } from "./context.js";

export type MaybePromise<T> = T | Promise<T>;

export type Next = () => Promise<void>;

export type AppHandler<Path extends string = string> = (
  c: Context<Path>,
  next: Next,
) => MaybePromise<HTTPRes | void>;

export type AppErrorHandler = (
  err: unknown,
  c: Context,
) => MaybePromise<HTTPRes>;

export type ValidationTarget = "json" | "query" | "param";

export type DispatchOptions = {
  clientIp: string;
};

export type WebSocketMessage = string | Buffer;

export type WebSocketConnection = {
  send: (data: WebSocketMessage) => Promise<void>;
  ping: () => Promise<void>;
  close: () => Promise<void>;
};

export type WebSocketRouteHandler = {
  /** Supported subprotocols for Sec-WebSocket-Protocol negotiation. */
  protocols?: string[];
  /** Select a protocol from client-offered list. Return undefined to decline. */
  negotiate?: (clientProtocols: string[]) => string | undefined;
  open?: (ws: WebSocketConnection, c: Context) => MaybePromise<void>;
  message?: (
    ws: WebSocketConnection,
    message: WebSocketMessage,
    c: Context,
  ) => MaybePromise<void>;
  close?: (ws: WebSocketConnection, c: Context) => MaybePromise<void>;
};

export type WebSocketRouteSession = {
  open?: (ws: WebSocketConnection) => MaybePromise<void>;
  message?: (
    ws: WebSocketConnection,
    message: WebSocketMessage,
  ) => MaybePromise<void>;
  close?: (ws: WebSocketConnection) => MaybePromise<void>;
};

export type AppDispatchResult = {
  response: HTTPRes;
  websocket?: WebSocketRouteSession;
};

export type ContextResponseInit = {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  chunked?: boolean;
  headOnly?: boolean;
};

/** A plugin installs middleware, routes, or configuration into an App. */
export interface Plugin {
  name: string;
  install: (app: import("./app.js").App) => void | Promise<void>;
}

/** Type-level param extraction from route strings like `/users/:id`. */
export type ExtractParam<T extends string> = T extends `:${infer P}` ? P : never;

export type ExtractParams<Path extends string> = Path extends `${infer A}/${infer B}`
  ? ExtractParam<A> | ExtractParams<B>
  : ExtractParam<Path>;

export type ParamsRecord<P extends string> = {
  [K in ExtractParams<P> as K extends string ? K : never]: string;
};
