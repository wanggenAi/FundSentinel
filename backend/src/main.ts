import { buildApp } from "./app.js";
import { safeStartupLogFields } from "./utils/safeLogging.js";

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "127.0.0.1";

const app = await buildApp();

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(safeStartupLogFields(error, { host, port }), "server failed to start");
  process.exit(1);
}
