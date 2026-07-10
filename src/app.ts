import path from "node:path";
import { z } from "zod";
import { readerEmptyWithLength, readerFromChunks } from "./body_readers.js";
import { serveStatic } from "./file_server.js";
import { HTTPError } from "./http_types.js";
import { App } from "./framework/app.js";
import { cors, logger, rateLimit } from "./framework/builtins.js";
import { zValidator } from "./framework/validation.js";
import type { Context } from "./framework/context.js";
import type {
  AppErrorHandler,
  WebSocketConnection,
  WebSocketMessage,
} from "./framework/types.js";

const FILES_DIR = path.join(process.cwd(), "files");

const createUserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
});

const userParamsSchema = z.object({
  id: z.string().min(1),
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
});

export const app: App = new App();

app.use(logger());
app.use(cors());
app.use(rateLimit());

const errorHandler: AppErrorHandler = (err, c) => {
  if (err instanceof HTTPError) {
    return c.status(err.code).json({ error: err.message });
  }
  if (err instanceof Error) {
    return c.status(500).json({ error: err.message });
  }
  return c.status(500).json({ error: "Internal Server Error" });
};

app.onError(errorHandler);

const api = app.group("/api/v1");

api.get("/health", (c: Context) => c.json({ status: "ok" }));

app.get("/stream", (c: Context) => {
  const chunks = [
    Buffer.from("This is the first chunk.\n", "utf8"),
    Buffer.from("And the second chunk.\n", "utf8"),
  ];
  return c.body(readerFromChunks(chunks), {
    contentType: "text/plain; charset=utf-8",
    chunked: true,
  });
});

app.head("/echo", (c: Context) =>
  c.body(readerEmptyWithLength(0), {
    headOnly: true,
  }),
);

app.get("/echo", (c: Context) => c.text("GET /echo\n"));

app.post("/echo", async (c: Context) => c.text(await c.req.text()));

app.post("/upload", async (c: Context) => {
  const body = await c.req.buffer();
  return c.text(`received ${body.length} bytes\n`);
});

api.get("/users/:id", zValidator("param", userParamsSchema), (c: Context) => {
  const params = c.valid<z.infer<typeof userParamsSchema>>("param");
  return c.json({ id: params.id });
});

api.post("/users", zValidator("json", createUserSchema), (c: Context) => {
  const user = c.valid<z.infer<typeof createUserSchema>>("json");
  return c.status(201).json({ ok: true, user });
});

api.get("/search", zValidator("query", searchQuerySchema), (c: Context) => {
  const query = c.valid<z.infer<typeof searchQuerySchema>>("query");
  return c.json({ query });
});

app.ws("/chat", {
  open: async (ws: WebSocketConnection) => {
    await ws.send("Welcome to the new framework WebSocket API!\n");
  },
  message: async (ws: WebSocketConnection, message: WebSocketMessage) => {
    if (typeof message === "string") {
      await ws.send(`Echo: ${message}\n`);
      return;
    }
    await ws.send(`Echo: [binary ${message.length}b]\n`);
  },
});

app.ws("/ws", {
  open: async (ws: WebSocketConnection) => {
    await ws.send("Connected to /ws\n");
  },
  message: async (ws: WebSocketConnection, message: WebSocketMessage) => {
    await ws.send(typeof message === "string" ? message : Buffer.from(message));
  },
});

app.get("/*", (c: Context) => serveStatic(c.req.raw, FILES_DIR));
app.head("/*", (c: Context) => serveStatic(c.req.raw, FILES_DIR));
