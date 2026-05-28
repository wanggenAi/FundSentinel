import assert from "node:assert/strict";
import test from "node:test";
import { SourceRegistry } from "../src/dataSources/index.js";
import { DataSourceService, FundAnalysisService, HomeService, OpportunityService } from "../src/services/index.js";

test("default FundAnalysisResponse with live providers disabled is data unavailable, not fake analysis", async () => {
  const response = await new FundAnalysisService(new SourceRegistry({ enableLiveProviders: false })).analyzeFund("007951", "analysis-flow");

  assert.equal(response.is_mock, false);
  assert.equal(response.final_decision.generated_by, "Atlas");
  assert.deepEqual(new Set(Object.keys(response.agent_results)), new Set(["Argus", "Atlas"]));
  assert.equal((response.blackboard_snapshot as { status: string }).status, "completed");
  assert.equal(response.data_pack.data_status, "unavailable");
  assert.ok(response.data_pack.data_gap_report?.recommended_solutions.length);
  assert.ok(response.data_pack.acquisition_solutions[0].engineering_tasks.length);
});

test("home service does not fake strategy triggers when live providers are disabled", async () => {
  const response = await new HomeService().getHomeDashboard();

  assert.equal(response.is_mock, true);
  assert.ok(response.holding_count > 0);
  assert.equal(response.strategy_triggers.length, 0);
  assert.ok(response.today_focus.some((item) => item.title === "真实数据不足"));
});

test("opportunity service does not fake candidates without real data", async () => {
  const response = await new OpportunityService().getOpportunities(5);

  assert.equal(response.candidates.length, 0);
  assert.match(response.summary, /真实核心数据不可用/);
});

test("demo mode can return demo analysis but forbids strong conclusions", async () => {
  const response = await new FundAnalysisService(new SourceRegistry({ demoMode: true, enableLiveProviders: false })).analyzeFund("007951", "demo-flow");

  assert.equal(response.data_pack.data_status, "demo");
  assert.equal(response.data_pack.allow_strong_conclusion, false);
  assert.equal(response.is_mock, true);
});

test("SourceRegistry lists real providers and demo fixture provider", () => {
  const sources = new SourceRegistry(false).listSources();

  assert.ok(sources.some((source) => source.source_id === "csrc-fund-disclosure" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "eastmoney-fund" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "cmfchina-fund-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "demo-fixture" && source.is_demo && !source.enabled));
});

test("SourceRegistry coverage matrix distinguishes implemented and gap requirements", () => {
  const coverage = new SourceRegistry({ enableLiveProviders: false }).coverageMatrix();
  const officialReports = coverage.find((item) => item.requirement === "official_fund_reports");
  const social = coverage.find((item) => item.requirement === "social_sentiment");

  assert.ok(officialReports?.source_ids.includes("csrc-fund-disclosure"));
  assert.ok(officialReports?.implemented_source_ids.includes("csrc-fund-disclosure"));
  assert.equal(officialReports?.gap_level, "partial");
  assert.equal(social?.gap_level, "missing");
});

test("DataSourceService returns gap and manual import plan", async () => {
  const service = new DataSourceService();
  const gap = await service.gaps("007951");
  const manualPlan = service.manualImportPlan();

  assert.ok(gap.missing_data.length > 0);
  assert.ok(gap.recommended_solutions.length > 0);
  assert.ok(manualPlan.solutions[0].engineering_tasks.length > 0);
});
