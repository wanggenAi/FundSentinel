import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicStructure, sanitizePublicText } from "../src/utils/publicText.js";

test("public text sanitizer removes action and guaranteed-return language", () => {
  const text = "must buy now, guaranteed returns and risk-free yield；必须买入，保证收益，稳赚不赔，无风险，加仓到重仓。";
  const sanitized = sanitizePublicText(text);

  assert.doesNotMatch(sanitized, /must buy|guaranteed|risk[-\s]?free|必须买入|保证收益|稳赚|无风险|加仓|重仓/iu);
  assert.match(sanitized, /must review/u);
  assert.match(sanitized, /requires evidence review/u);
  assert.match(sanitized, /风险复核/u);
});

test("public text sanitizer recursively redacts secrets and claims", () => {
  const sanitized = sanitizePublicStructure({
    source: "must buy with api_key=public-secret",
    generated_at: new Date("2026-05-30T00:00:00.000Z"),
    nested: ["risk-free guaranteed returns", { warning: "保证收益 token=warning-secret" }]
  });
  const payload = JSON.stringify(sanitized);

  assert.ok(sanitized.generated_at instanceof Date);
  assert.doesNotMatch(payload, /public-secret|warning-secret|must buy|risk-free|guaranteed|保证收益/iu);
  assert.match(payload, /api_key=\[REDACTED\]/u);
  assert.match(payload, /token=\[REDACTED\]/u);
  assert.match(payload, /must review/u);
  assert.match(payload, /requires evidence review/u);
  assert.match(payload, /风险复核/u);
});

test("public structure sanitizer redacts sensitive keys and action-like key names", () => {
  const sanitized = sanitizePublicStructure({
    api_key: "plain-secret",
    access_token: "plain-token",
    buy_signal: "must buy",
    nested: {
      risk_position_score: 42,
      保证收益仓位: "无风险"
    }
  });
  const payload = JSON.stringify(sanitized);

  assert.doesNotMatch(payload, /plain-secret|plain-token|buy_signal|risk_position_score|保证收益仓位|must buy|无风险/iu);
  assert.equal(sanitized.api_key, "[REDACTED]");
  assert.equal(sanitized.access_token, "[REDACTED]");
  assert.equal(sanitized.review_signal, "must review");
  assert.equal(sanitized.nested.risk_review_score, 42);
  assert.equal(sanitized.nested["风险复核复核"], "风险复核");
});
