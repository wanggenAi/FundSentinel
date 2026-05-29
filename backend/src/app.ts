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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: "Not found",
      is_mock: false
    })
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(error);
    const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
      is_mock: false
    });
  });

  return app;
}
