import assert from "node:assert/strict";
import test from "node:test";
import { SourceRegistry, type DataProvider, type DataProviderResult, type DataSourceInfo, type FundDataSourceInput, type ProviderFundPayload } from "../src/dataSources/index.js";
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
  assert.ok(sources.some((source) => source.source_id === "eastmoney-nav-history" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "cmfchina-fund-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "demo-fixture" && source.is_demo && !source.enabled));
});

test("SourceRegistry coverage matrix distinguishes implemented and gap requirements", () => {
  const coverage = new SourceRegistry({ enableLiveProviders: false }).coverageMatrix();
  const officialReports = coverage.find((item) => item.requirement === "official_fund_reports");
  const navHistory = coverage.find((item) => item.requirement === "nav_history");
  const macroData = coverage.find((item) => item.requirement === "macro_data");
  const social = coverage.find((item) => item.requirement === "social_sentiment");

  assert.ok(officialReports?.source_ids.includes("csrc-fund-disclosure"));
  assert.ok(officialReports?.implemented_source_ids.includes("csrc-fund-disclosure"));
  assert.equal(officialReports?.gap_level, "partial");
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-fund"));
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-nav-history"));
  assert.ok(macroData?.source_ids.includes("stats-gov-cn"));
  assert.ok(macroData?.source_ids.includes("fred-official"));
  assert.ok(macroData?.source_ids.includes("world-bank-api"));
  assert.ok(macroData?.source_ids.includes("imf-data-api"));
  assert.ok(macroData?.implemented_source_ids.includes("stats-gov-cn"));
  assert.ok(macroData?.implemented_source_ids.includes("world-bank-api"));
  assert.equal(macroData?.gap_level, "covered");
  assert.equal(social?.gap_level, "missing");
});

test("SourceRegistry caches successful real provider results and exposes cache health", async () => {
  const provider = new CountingProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0 });
  const input = { fund_code: "007951", required_data: ["fund_meta", "current_nav", "nav_history"], demo_mode: false };

  const first = await registry.fetchAll(input);
  const second = await registry.fetchAll(input);
  const health = registry.health().find((source) => source.source_id === "counting-provider");

  assert.equal(provider.callCount, 1);
  assert.equal(first[0].cache_hit, false);
  assert.equal(second[0].cache_hit, true);
  assert.equal(second[0].latency_ms, 0);
  assert.equal(health?.cache_hit_count, 1);
  assert.equal(health?.cache_entries, 1);
});

test("SourceRegistry keeps default provider cache across registry instances", async () => {
  const provider = new CountingProvider("shared-counting-provider");
  const firstRegistry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0, shareState: true });
  const secondRegistry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0, shareState: true });

  const first = await firstRegistry.fetchAll({ fund_code: "007951", required_data: ["fund_meta"], demo_mode: false });
  const second = await secondRegistry.fetchAll({ fund_code: "007951", required_data: ["fund_meta"], demo_mode: false });

  assert.equal(provider.callCount, 1);
  assert.equal(first[0].success, true);
  assert.equal(second[0].success, true);
  assert.equal(second[0].cache_hit, true);
});

test("SourceRegistry retries transient provider failures but does not cache failures", async () => {
  const provider = new FlakyProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 1 });
  const result = (await registry.fetchAll({ fund_code: "007951", required_data: ["fund_meta"], demo_mode: false }))[0];
  const health = registry.health().find((source) => source.source_id === "flaky-provider");

  assert.equal(provider.callCount, 2);
  assert.equal(result.success, true);
  assert.equal(result.attempt_count, 2);
  assert.equal(result.cache_hit, false);
  assert.equal(health?.last_attempt_count, 2);
});

test("SourceRegistry converts uncaught provider exceptions into failed results", async () => {
  const provider = new ThrowingProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 0, retryCount: 0 });
  const result = (await registry.fetchAll({ fund_code: "007951", required_data: ["fund_meta"], demo_mode: false }))[0];
  const health = registry.health().find((source) => source.source_id === "throwing-provider");

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /network timeout/);
  assert.ok(result.warnings.some((warning) => warning.includes("未捕获异常")));
  assert.equal(health?.failure_count, 1);
});

test("SourceRegistry opens circuit breaker after repeated provider failures", async () => {
  const provider = new AlwaysFailProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 0, retryCount: 0, failureThreshold: 2, failureCooldownMs: 60_000 });
  const input = { fund_code: "007951", required_data: ["fund_meta"], demo_mode: false };

  const first = (await registry.fetchAll(input))[0];
  const second = (await registry.fetchAll(input))[0];
  const third = (await registry.fetchAll(input))[0];
  const health = registry.health().find((source) => source.source_id === "always-fail-provider");

  assert.equal(first.skipped_by_circuit_breaker, false);
  assert.equal(second.skipped_by_circuit_breaker, false);
  assert.equal(third.skipped_by_circuit_breaker, true);
  assert.equal(third.attempt_count, 0);
  assert.equal(provider.callCount, 2);
  assert.equal(health?.health_status, "cooldown");
  assert.ok((health?.cooldown_remaining_ms ?? 0) > 0);
});

test("DataSourceService returns gap and manual import plan", async () => {
  const service = new DataSourceService();
  const gap = await service.gaps("007951");
  const manualPlan = service.manualImportPlan();

  assert.ok(gap.missing_data.length > 0);
  assert.ok(gap.recommended_solutions.length > 0);
  assert.ok(manualPlan.solutions[0].engineering_tasks.length > 0);
});

function sourceInfo(sourceId: string): DataSourceInfo {
  return {
    source_id: sourceId,
    source_name: sourceId,
    source_type: "fund_meta",
    trust_level: "B",
    enabled: true,
    priority: 1,
    access_method: "test fixture provider",
    requires_auth: false,
    is_demo: false,
    last_success_at: null,
    last_failed_at: null,
    failure_count: 0,
    consecutive_failure_count: 0,
    last_latency_ms: null,
    last_attempt_count: 0,
    cache_hit_count: 0,
    last_cache_hit_at: null,
    circuit_open_until: null,
    circuit_open_count: 0,
    freshness_policy: "test",
    notes: "test provider"
  };
}

function providerResult(sourceId: string, success: boolean): DataProviderResult<ProviderFundPayload> {
  const info = sourceInfo(sourceId);
  return {
    source_id: info.source_id,
    source_name: info.source_name,
    source_type: info.source_type,
    trust_level: info.trust_level,
    data_status: success ? "partial" : "unavailable",
    success,
    data: success
      ? {
          fund_code: "007951",
          fund_name: "Test Fund",
          current_nav: 1,
          nav_history: [0.98, 1]
        }
      : null,
    raw_reference: "test://provider",
    fetched_at: new Date().toISOString(),
    freshness: "fresh",
    warnings: [],
    error: success ? null : "timeout while fetching provider",
    is_demo: false
  };
}

class CountingProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;

  constructor(private readonly sourceId = "counting-provider") {}

  sourceInfo(): DataSourceInfo {
    return sourceInfo(this.sourceId);
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    return providerResult(this.sourceId, true);
  }
}

class FlakyProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;

  sourceInfo(): DataSourceInfo {
    return sourceInfo("flaky-provider");
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    return providerResult("flaky-provider", this.callCount > 1);
  }
}

class ThrowingProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return sourceInfo("throwing-provider");
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    throw new Error("network timeout");
  }
}

class AlwaysFailProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;

  sourceInfo(): DataSourceInfo {
    return sourceInfo("always-fail-provider");
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    return providerResult("always-fail-provider", false);
  }
}
