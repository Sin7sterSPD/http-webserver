/** Full-featured modular server powered by the custom framework layer. */
import { app } from "./app.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT) || 1234;

app.listen({ host, port, printRoutes: true });
