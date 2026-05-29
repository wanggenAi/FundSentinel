import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.equal(payload.is_mock, false);
});

test("API home returns HomeDashboardResponse", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/home" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.is_mock, false);
  assert.equal(payload.generated_by, "Atlas");
  assert.equal(payload.holding_count, 0);
  assert.equal(payload.total_assets, 0);
  assert.equal(payload.strategy_triggers.length, 0);
  assert.ok(payload.today_focus.some((item: { title: string }) => item.title === "真实持仓未配置"));
  assert.ok(payload.data_quality.warnings.some((warning: string) => warning.includes("FUNDSENTINEL_PORTFOLIO_FILE")));
  assert.doesNotMatch(JSON.stringify(payload), /suggested_action/);
});

test("API agents returns public orchestration catalog", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/agents" });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  const aegis = payload.find((agent: { name: string }) => agent.name === "Aegis");
  const nadir = payload.find((agent: { name: string }) => agent.name === "Nadir");
  assert.equal(aegis?.role, "Risk Review Agent");
  assert.equal(nadir?.role, "Valuation Review Agent");
  assert.doesNotMatch(JSON.stringify(payload), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
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
  assert.match(payload.summary, /未配置真实基金候选池/);
  assert.doesNotMatch(JSON.stringify(payload), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
});

test("API fund analysis and analyze post return public analysis", async () => {
  const app = await buildApp();
  const userRequest = "分析这个基金现在是否适合进入观察或试探买入";
  const getResponse = await app.inject({ method: "GET", url: "/api/funds/007951/analysis" });
  const postResponse = await app.inject({
    method: "POST",
    url: "/api/analyze",
    payload: { fund_code: "007951", user_request: userRequest }
  });
  await app.close();

  assert.equal(getResponse.statusCode, 200);
  const getPayload = getResponse.json();
  assert.equal(getPayload.fund_code, "007951");
  assert.deepEqual(new Set(Object.keys(getPayload.agent_results)), new Set(["Argus", "Atlas"]));
  assert.equal(getPayload.final_review.generated_by, "Atlas");
  assert.equal(getPayload.final_review.review_status, "data_gap_review");
  assert.equal(getPayload.data_pack.data_status, "unavailable");
  assert.equal("final_decision" in getPayload, false);
  assert.equal("blackboard_snapshot" in getPayload, false);
  assert.equal("action" in getPayload.final_review, false);
  assert.ok(getPayload.traceability.data_gap_report.recommended_solutions.length > 0);
  assert.doesNotMatch(JSON.stringify(getPayload), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);

  assert.equal(postResponse.statusCode, 200);
  const postPayload = postResponse.json();
  assert.equal(postPayload.data_pack.data_status, "unavailable");
  assert.equal(postPayload.final_review.review_status, "data_gap_review");
  assert.equal(postPayload.task_id, `api-analyze-007951-${createHash("sha256").update(userRequest).digest("hex").slice(0, 12)}`);
  assert.equal(postPayload.fund_code, "007951");
  assert.doesNotMatch(postPayload.task_id, /试探买入|观察/iu);
});

test("API analyze rejects invalid request without mock data marker", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "POST", url: "/api/analyze", payload: { fund_code: "   ", user_request: "  " } });
  await app.close();

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().is_mock, false);
});

test("API unknown routes return non-mock error envelope", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/unknown-route" });
  await app.close();

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error, "Not found");
  assert.equal(response.json().is_mock, false);
});

test("API analyze trims request identifiers before tracing", async () => {
  const app = await buildApp();
  const userRequest = "  request with whitespace  ";
  const response = await app.inject({
    method: "POST",
    url: "/api/analyze",
    payload: { fund_code: "  SPY  ", user_request: userRequest }
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.fund_code, "SPY");
  assert.equal(payload.task_id, `api-analyze-SPY-${createHash("sha256").update(userRequest.trim()).digest("hex").slice(0, 12)}`);
});

test("API fund identifier routes reject blank identifiers without mock data marker", async () => {
  const app = await buildApp();
  const analysisResponse = await app.inject({ method: "GET", url: "/api/funds/%20%20%20/analysis" });
  const gapResponse = await app.inject({ method: "GET", url: "/api/data-sources/gaps/%20%20%20" });
  await app.close();

  assert.equal(analysisResponse.statusCode, 400);
  assert.equal(analysisResponse.json().is_mock, false);
  assert.equal(gapResponse.statusCode, 400);
  assert.equal(gapResponse.json().is_mock, false);
});

test("API fund identifier routes reject unsafe identifier characters", async () => {
  const app = await buildApp();
  const postResponse = await app.inject({
    method: "POST",
    url: "/api/analyze",
    payload: { fund_code: "007951/../../x", user_request: "review" }
  });
  const analysisResponse = await app.inject({ method: "GET", url: "/api/funds/007951%2F..%2F..%2Fx/analysis" });
  const gapResponse = await app.inject({ method: "GET", url: "/api/data-sources/gaps/007951%2F..%2F..%2Fx" });
  await app.close();

  assert.equal(postResponse.statusCode, 400);
  assert.equal(postResponse.json().is_mock, false);
  assert.equal(analysisResponse.statusCode, 400);
  assert.equal(analysisResponse.json().is_mock, false);
  assert.equal(gapResponse.statusCode, 400);
  assert.equal(gapResponse.json().is_mock, false);
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
  assert.doesNotMatch(JSON.stringify(sourcesResponse.json()), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
  assert.equal(catalogResponse.statusCode, 200);
  assert.ok(catalogResponse.json().sources.some((source: { source_id: string }) => source.source_id === "csrc-fund-disclosure"));
  assert.ok(catalogResponse.json().sources.some((source: { source_id: string }) => source.source_id === "commercial-terminal-api"));
  assert.doesNotMatch(JSON.stringify(catalogResponse.json()), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
  assert.equal(coverageResponse.statusCode, 200);
  assert.ok(coverageResponse.json().coverage.some((item: { requirement: string }) => item.requirement === "official_fund_reports"));
  assert.ok(coverageResponse.json().coverage.some((item: { requirement: string }) => item.requirement === "official_current_nav"));
  assert.ok(coverageResponse.json().coverage.some((item: { requirement: string }) => item.requirement === "official_nav_history"));
  const officialReportsCoverage = coverageResponse.json().coverage.find((item: { requirement: string }) => item.requirement === "official_fund_reports");
  assert.equal(officialReportsCoverage.implemented_source_ids.includes("fund-company-report"), false);
  assert.ok(officialReportsCoverage.coordinator_source_ids.includes("fund-company-report"));
  assert.equal(healthResponse.statusCode, 200);
  assert.ok(
    healthResponse
      .json()
      .sources.some((source: { source_id: string; cache_entries: number; last_attempt_count: number }) => source.source_id === "csrc-fund-disclosure" && "cache_entries" in source)
  );
  assert.equal(gapsResponse.statusCode, 200);
  assert.equal(gapsResponse.json().is_mock, false);
  assert.doesNotMatch(JSON.stringify(gapsResponse.json()), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
  assert.ok(gapsResponse.json().recommended_solutions.length > 0);
  assert.ok(gapsResponse.json().recommended_solutions.some((solution: string) => solution.includes("official_current_nav")));
  assert.equal(gapsResponse.json().allow_strong_conclusion, false);
  assert.equal(gapsResponse.json().source_composition.official_core_coverage.current_nav, false);
  assert.equal(gapsResponse.json().source_composition.official_core_coverage.nav_history, false);
  assert.equal(gapsResponse.json().source_composition.official_core_coverage.fund_reports, false);
  assert.ok(gapsResponse.json().acquisition_solutions[0].engineering_tasks.length > 0);
  assert.ok(gapsResponse.json().acquisition_solutions[0].manual_workaround.length > 0);
  assert.equal(manualPlanResponse.statusCode, 200);
  assert.ok(manualPlanResponse.json().solutions[0].engineering_tasks.length > 0);
  assert.ok(manualPlanResponse.json().required_portfolio_json_fields.includes("holdings[].current_nav"));
  assert.ok(manualPlanResponse.json().required_report_manifest_fields.includes("pdf_sha256"));
  assert.equal(manualPlanResponse.json().report_manifest_filename, "{fund_code}.reports.json");
  assert.ok(manualPlanResponse.json().warnings.some((warning: string) => warning.includes("FUNDSENTINEL_PORTFOLIO_FILE")));
  assert.ok(manualPlanResponse.json().warnings.some((warning: string) => warning.includes("FUNDSENTINEL_MANUAL_REPORT_DIR")));
});
