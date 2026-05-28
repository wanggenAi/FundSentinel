import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";

test("API returns health", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.runtime, "typescript-fastify");
  assert.equal(payload.is_mock, true);
});

test("API home returns HomeDashboardResponse", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/home" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.is_mock, true);
  assert.equal(payload.generated_by, "Atlas");
  assert.ok(payload.strategy_triggers.length > 0);
  assert.ok(payload.strategy_triggers.every((trigger: { related_agent?: string }) => trigger.related_agent));
});

test("API opportunities returns OpportunitySquareResponse", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/opportunities?limit=5" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.is_mock, true);
  assert.equal(payload.generated_by, "Atlas");
  assert.equal(payload.candidates.length, 5);
  assert.ok(payload.candidates.every((candidate: Record<string, unknown>) => "overall_opportunity_score" in candidate));
  assert.ok(payload.candidates.every((candidate: Record<string, unknown>) => "action" in candidate));
});

test("API fund analysis and analyze post return full analysis", async () => {
  const app = await buildApp();
  const getResponse = await app.inject({ method: "GET", url: "/api/funds/007951/analysis" });
  const postResponse = await app.inject({
    method: "POST",
    url: "/api/analyze",
    payload: { fund_code: "007951", user_request: "分析这个基金现在是否适合进入观察或试探买入" }
  });
  await app.close();

  assert.equal(getResponse.statusCode, 200);
  const getPayload = getResponse.json();
  assert.equal(getPayload.fund_code, "007951");
  assert.deepEqual(new Set(Object.keys(getPayload.agent_results)), new Set(["Argus", "Logos", "Nadir", "Vega", "Aegis", "Atlas"]));
  assert.equal(getPayload.final_decision.generated_by, "Atlas");

  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.json().is_mock, true);
});

