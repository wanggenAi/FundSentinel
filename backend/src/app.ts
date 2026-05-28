import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerRoutes } from "./api/routes.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  return app;
}

