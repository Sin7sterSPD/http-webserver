import type { HTTPRes } from "../http_types.js";
import type { Context } from "./context.js";

export type MaybePromise<T> = T | Promise<T>;

export type Next = () => Promise<void>;

export type AppHandler = (
  c: Context,
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
  close: () => Promise<void>;
};

export type WebSocketRouteHandler = {
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
