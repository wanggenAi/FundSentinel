import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyLoggerOptions } from "fastify";
import { registerRoutes } from "./api/routes.js";

const REDACTED_LOG_VALUE = "[REDACTED]";

type RequestLogSerializer = NonNullable<NonNullable<FastifyLoggerOptions["serializers"]>["req"]>;
type ErrorLogSerializer = NonNullable<NonNullable<FastifyLoggerOptions["serializers"]>["err"]>;

interface BuildAppOptions {
  logger?: FastifyLoggerOptions;
}

function statusCodeForError(error: unknown): number {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : null;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}

function messageForError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : null;
  return typeof message === "string" && message.trim() ? message : "Request failed";
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|secret|password|credential)=)[^&\s]*/giu, `$1${REDACTED_LOG_VALUE}`)
    .replace(
      /\b((?:api[_-]?key|token|access[_-]?token|secret|password|credential)\s*[:=]\s*)["']?[^"',\s}]*/giu,
      `$1${REDACTED_LOG_VALUE}`
    );
}

function publicErrorMessage(error: unknown, statusCode: number): string {
  return statusCode >= 500 ? "Internal server error" : redactSensitiveText(messageForError(error));
}

function errorNameForLog(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error === "object" && error !== null && "name" in error ? error.name : null;
  return typeof name === "string" && name.trim() ? redactSensitiveText(name) : "UnknownError";
}

function errorCodeForLog(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (typeof code !== "string" && typeof code !== "number") return undefined;
  return redactSensitiveText(String(code));
}

export function safeErrorLogFields(error: unknown, statusCode = statusCodeForError(error)) {
  return {
    error_name: errorNameForLog(error),
    error_code: errorCodeForLog(error),
    error_message: publicErrorMessage(error, statusCode)
  };
}

const requestLogSerializer: RequestLogSerializer = (request) => ({
  method: request.method,
  url: redactSensitiveText(request.url),
  host: request.host,
  remoteAddress: request.ip,
  remotePort: request.port ?? undefined
});

const errorLogSerializer: ErrorLogSerializer = (error) => ({
  type: errorNameForLog(error),
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
