export const REDACTED_LOG_VALUE = "[REDACTED]";

const SECRET_KEY_PATTERN = "(?:api[_-]?key|access[_-]?token|token|secret|password|credential)";
const QUERY_SECRET_KEY_PATTERN = `(?:${SECRET_KEY_PATTERN}|authorization)`;
const SENSITIVE_OBJECT_KEY_PATTERN = new RegExp(`${SECRET_KEY_PATTERN}|authorization`, "iu");

export function statusCodeForError(error: unknown): number {
  const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : null;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}

function messageForError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = typeof error === "object" && error !== null && "message" in error ? error.message : null;
  return typeof message === "string" && message.trim() ? message : "Request failed";
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)Bearer\s+[^"',\s}]*/giu, `$1Bearer ${REDACTED_LOG_VALUE}`)
    .replace(/\bBearer\s+[^"',\s}]*/giu, `Bearer ${REDACTED_LOG_VALUE}`)
    .replace(new RegExp(`([?&]${QUERY_SECRET_KEY_PATTERN}=)[^&\\s]*`, "giu"), `$1${REDACTED_LOG_VALUE}`)
    .replace(new RegExp(`\\b(${SECRET_KEY_PATTERN}\\s*[:=]\\s*)["']?[^"',&\\s}]*`, "giu"), `$1${REDACTED_LOG_VALUE}`);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_OBJECT_KEY_PATTERN.test(key);
}

export function redactSensitiveStrings<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveStrings(item)) as T;
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [redactSensitiveText(key), isSensitiveKey(key) ? REDACTED_LOG_VALUE : redactSensitiveStrings(entry)])
  ) as T;
}

export function publicErrorMessage(error: unknown, statusCode: number): string {
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

export function safeStartupLogFields(error: unknown, context: { host: string; port: number }) {
  return {
    host: redactSensitiveText(context.host),
    port: context.port,
    ...safeErrorLogFields(error)
  };
}
