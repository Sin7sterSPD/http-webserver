# HTTP Web Server Framework

A TypeScript HTTP framework built from scratch on top of Node TCP sockets.

This project started as a raw HTTP server implementation and now includes a small framework layer inspired by Hono/Elysia while keeping the custom HTTP core.

## What it supports

- Custom TCP-based HTTP server core
- Manual HTTP request parsing and response writing
- Elegant route API with `App`
- Route groups with `app.group()`
- Context helpers like `c.json()`, `c.text()`, `c.html()`, `c.status()` and `c.header()`
- Request helpers like `c.req.param()`, `c.req.query()`, `c.req.text()`, `c.req.json()` and `c.req.buffer()`
- Middleware with `app.use()`
- Zod validation with `zValidator()`
- Route-level WebSocket API with `app.ws()`
- Static file serving with caching, range requests and gzip support
- Token-bucket rate limiting
- In-memory request testing helper

## Run

```bash
npm install
npm run serve
```

The server starts on:

```txt
http://127.0.0.1:1234
```

You can use a different port:

```bash
PORT=8080 npm run serve
```

## Main app API

The application is defined in `src/app.ts`:

```ts
import { z } from "zod";
import { App, zValidator } from "./framework/index.js";

const app = new App();

app.get("/health", (c) => c.json({ status: "ok" }));

const api = app.group("/api/v1");

api.post(
  "/users",
  zValidator(
    "json",
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
    }),
  ),
  (c) => c.status(201).json({ user: c.valid("json") }),
);

app.ws("/chat", {
  open: (ws) => ws.send("Welcome!"),
  message: (ws, message) => ws.send(`Echo: ${message}`),
});

app.listen(1234);
```

## Demo routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | JSON health check |
| `GET` | `/api/v1/users/:id` | Typed route param demo |
| `POST` | `/api/v1/users` | Zod JSON validation demo |
| `GET` | `/api/v1/search?q=hello` | Zod query validation demo |
| `GET` | `/stream` | Chunked response demo |
| `POST` | `/echo` | Echo body demo |
| `POST` | `/upload` | Body size demo |
| `WS` | `/chat` | WebSocket echo demo |
| `WS` | `/ws` | WebSocket raw echo demo |
| `GET` | `/*` | Static files from `files/` |

## Example requests

```bash
curl http://127.0.0.1:1234/api/v1/health
```

```bash
curl http://127.0.0.1:1234/api/v1/users/42
```

```bash
curl -X POST http://127.0.0.1:1234/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com"}'
```

```bash
curl http://127.0.0.1:1234/api/v1/search?q=hello
```

## Testing helper

You can test an app without opening a socket:

```ts
import { request } from "./framework/index.js";
import { app } from "./app.js";

const res = await request(app, "/api/v1/health");
console.log(res.status); // 200
console.log(res.json()); // { status: "ok" }
```

## Architecture

```txt
TCP socket
  -> custom socket wrapper
  -> custom HTTP parser
  -> App.dispatch()
  -> middleware
  -> router/group handler
  -> Context response helpers
  -> custom HTTP response writer
```

The low-level HTTP engine still lives in files like:

- `src/tcp.ts`
- `src/http_parser.ts`
- `src/http_response.ts`
- `src/websocket.ts`

The framework layer lives in:

- `src/framework/app.ts`
- `src/framework/context.ts`
- `src/framework/request.ts`
- `src/framework/validation.ts`
- `src/framework/testing.ts`

## Current limitations

- Request body helpers currently work best with `Content-Length`; chunked request-body parsing is not fully implemented yet.
- The WebSocket implementation is intentionally minimal: text, binary, ping/pong and close are supported, but advanced RFC features like fragmentation and subprotocol negotiation are not yet implemented.
- Type inference can be improved further, especially automatic typed route params and schema result inference.

## Next roadmap

Good next upgrades:

1. Automatic typed params from route strings like `/users/:id`
2. Fetch-compatible `Request`/`Response` adapter
3. Plugin API for auth, cookies, JWT and OpenAPI
4. Chunked request-body parser
5. Better WebSocket subprotocol support
6. Benchmarks against Express, Hono Node adapter and Fastify
