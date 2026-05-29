import assert from "node:assert/strict";
import test from "node:test";
import { publicErrorMessage, redactSensitiveText, safeStartupLogFields, statusCodeForError } from "../src/utils/safeLogging.js";

test("safe logging redacts query credentials and bearer tokens", () => {
  const text =
    "GET /provider?api_key=query-secret&authorization=Bearer%20query-token authorization: Bearer header-secret token=body-secret password: quoted-secret";
  const redacted = redactSensitiveText(text);

  assert.doesNotMatch(redacted, /query-secret|query-token|header-secret|body-secret|quoted-secret/u);
  assert.match(redacted, /api_key=\[REDACTED\]/u);
  assert.match(redacted, /authorization=\[REDACTED\]/u);
  assert.match(redacted, /Bearer \[REDACTED\]/u);
  assert.match(redacted, /token=\[REDACTED\]/u);
  assert.match(redacted, /password: \[REDACTED\]/u);
});

test("safe logging hides server errors while preserving redacted client errors", () => {
  const serverError = new Error("upstream failed api_key=server-secret");
  const clientError = new Error("bad request token=client-secret");
  (clientError as Error & { statusCode: number }).statusCode = 400;

  assert.equal(statusCodeForError(serverError), 500);
  assert.equal(publicErrorMessage(serverError, 500), "Internal server error");
  assert.equal(statusCodeForError(clientError), 400);
  assert.equal(publicErrorMessage(clientError, 400), "bad request token=[REDACTED]");
});

test("safe startup log fields do not include raw startup exception secrets", () => {
  const error = new Error("listen failed credential=startup-secret");
  (error as Error & { code: string }).code = "EADDRINUSE-token=code-secret";
  const fields = safeStartupLogFields(error, { host: "127.0.0.1?api_key=host-secret", port: 8000 });
  const serialized = JSON.stringify(fields);

  assert.equal(fields.port, 8000);
  assert.equal(fields.error_message, "Internal server error");
  assert.doesNotMatch(serialized, /startup-secret|code-secret|host-secret|listen failed/u);
  assert.match(serialized, /api_key=\[REDACTED\]/u);
  assert.match(serialized, /token=\[REDACTED\]/u);
});
