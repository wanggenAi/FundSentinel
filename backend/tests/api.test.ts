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
  assert.equal(payload.strategy_triggers.length, 0);
  assert.ok(payload.today_focus.some((item: { title: string }) => item.title === "真实数据不足"));
});

test("API opportunities returns OpportunitySquareResponse", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/opportunities?limit=5" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.is_mock, false);
  assert.equal(payload.generated_by, "Atlas");
  assert.equal(payload.candidates.length, 0);
  assert.match(payload.summary, /真实核心数据不可用/);
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
  assert.deepEqual(new Set(Object.keys(getPayload.agent_results)), new Set(["Argus", "Atlas"]));
  assert.equal(getPayload.final_decision.generated_by, "Atlas");
  assert.equal(getPayload.data_pack.data_status, "unavailable");

  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.json().data_pack.data_status, "unavailable");
});

test("data source APIs are available", async () => {
  const app = await buildApp();
  const sourcesResponse = await app.inject({ method: "GET", url: "/api/data-sources" });
  const catalogResponse = await app.inject({ method: "GET", url: "/api/data-sources/catalog" });
  const coverageResponse = await app.inject({ method: "GET", url: "/api/data-sources/coverage" });
  const healthResponse = await app.inject({ method: "GET", url: "/api/data-sources/health" });
  const gapsResponse = await app.inject({ method: "GET", url: "/api/data-sources/gaps/007951" });
  const manualPlanResponse = await app.inject({ method: "POST", url: "/api/data-sources/manual-import/plan" });
  await app.close();

  assert.equal(sourcesResponse.statusCode, 200);
  assert.ok(sourcesResponse.json().sources.some((source: { source_id: string }) => source.source_id === "demo-fixture"));
  assert.equal(catalogResponse.statusCode, 200);
  assert.ok(catalogResponse.json().sources.some((source: { source_id: string }) => source.source_id === "csrc-fund-disclosure"));
  assert.ok(catalogResponse.json().sources.some((source: { source_id: string }) => source.source_id === "commercial-terminal-api"));
  assert.equal(coverageResponse.statusCode, 200);
  assert.ok(coverageResponse.json().coverage.some((item: { requirement: string }) => item.requirement === "official_fund_reports"));
  assert.equal(healthResponse.statusCode, 200);
  assert.ok(
    healthResponse
      .json()
      .sources.some((source: { source_id: string; cache_entries: number; last_attempt_count: number }) => source.source_id === "csrc-fund-disclosure" && "cache_entries" in source)
  );
  assert.equal(gapsResponse.statusCode, 200);
  assert.ok(gapsResponse.json().recommended_solutions.length > 0);
  assert.equal(manualPlanResponse.statusCode, 200);
  assert.ok(manualPlanResponse.json().solutions[0].engineering_tasks.length > 0);
});
