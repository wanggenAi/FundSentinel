import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyLoggerOptions } from "fastify";
import { registerRoutes } from "./api/routes.js";
import { publicErrorMessage, redactSensitiveText, safeErrorLogFields, statusCodeForError } from "./utils/safeLogging.js";

type RequestLogSerializer = NonNullable<NonNullable<FastifyLoggerOptions["serializers"]>["req"]>;
type ErrorLogSerializer = NonNullable<NonNullable<FastifyLoggerOptions["serializers"]>["err"]>;

interface BuildAppOptions {
  logger?: FastifyLoggerOptions;
}

const requestLogSerializer: RequestLogSerializer = (request) => ({
  method: request.method,
  url: redactSensitiveText(request.url),
  host: request.host,
  remoteAddress: request.ip,
  remotePort: request.port ?? undefined
});

const errorLogSerializer: ErrorLogSerializer = (error) => ({
  type: safeErrorLogFields(error).error_name,
  message: publicErrorMessage(error, statusCodeForError(error)),
  stack: ""
});

function loggerOptions(overrides?: FastifyLoggerOptions): FastifyLoggerOptions {
  return {
    ...overrides,
    level: overrides?.level ?? process.env.LOG_LEVEL ?? "info",
    serializers: {
      ...(overrides?.serializers ?? {}),
      req: requestLogSerializer,
      err: errorLogSerializer
    }
  };
}

function logRequestError(logger: Pick<FastifyBaseLogger, "error">, error: unknown, statusCode: number, request: { method: string; url: string }) {
  logger.error(
    {
      status_code: statusCode,
      method: request.method,
      url: redactSensitiveText(request.url),
      ...safeErrorLogFields(error, statusCode)
    },
    "request failed"
  );
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: loggerOptions(options.logger)
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
    const statusCode = statusCodeForError(error);
    logRequestError(request.log, error, statusCode, request);
    return reply.code(statusCode).send({
      error: publicErrorMessage(error, statusCode),
      is_mock: false
    });
  });

  return app;
}
