import cors from "@fastify/cors";
import Fastify from "fastify";
import { registerRoutes } from "./api/routes.js";

function statusCodeForError(error: unknown): number {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : null;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}

function messageForError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : null;
  return typeof message === "string" && message.trim() ? message : "Request failed";
}

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
    const statusCode = statusCodeForError(error);
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : messageForError(error),
      is_mock: false
    });
  });

  return app;
}
