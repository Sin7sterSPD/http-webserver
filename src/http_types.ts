import type * as net from "node:net";

export type TCPConn = {
  socket: net.Socket;
  err: Error | null;
  ended: boolean;
  reader: null | {
    resolve: (value: Buffer) => void;
    reject: (reason: Error) => void;
  };
};

export type DynBuf = {
  data: Buffer;
  length: number;
};

export type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

export type BodyReader = {
  length: number;
  read: () => Promise<Buffer>;
};

export type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
  /** Use Transfer-Encoding: chunked (body.length should be -1). */
  chunked?: boolean;
  /** HEAD: send Content-Length but do not write a body. */
  headOnly?: boolean;
};

export class HTTPError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "HTTPError";
    this.code = code;
  }
}
