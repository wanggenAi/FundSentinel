import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicText } from "../src/utils/publicText.js";

test("public text sanitizer removes action and guaranteed-return language", () => {
  const text = "must buy now, guaranteed returns and risk-free yield；必须买入，保证收益，稳赚不赔，无风险，加仓到重仓。";
  const sanitized = sanitizePublicText(text);

  assert.doesNotMatch(sanitized, /must buy|guaranteed|risk[-\s]?free|必须买入|保证收益|稳赚|无风险|加仓|重仓/iu);
  assert.match(sanitized, /must review/u);
  assert.match(sanitized, /requires evidence review/u);
  assert.match(sanitized, /风险复核/u);
});
