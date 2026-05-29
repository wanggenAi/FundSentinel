import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listDataSourceCatalog,
  SourceRegistry,
  type DataProvider,
  type DataProviderResult,
  type DataSourceInfo,
  type FundDataSourceInput,
  type ProviderFundPayload
} from "../src/dataSources/index.js";
import type { FundAnalysisResponse } from "../src/schemas/index.js";
import { DataSourceService, FundAnalysisService, HomeService, MockDataService, OpportunityService, PortfolioService, StrategyTriggerService } from "../src/services/index.js";

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

test("home service does not fake holdings or strategy triggers without a configured portfolio source", async () => {
  const response = await new HomeService().getHomeDashboard();

  assert.equal(response.is_mock, false);
  assert.equal(response.holding_count, 0);
  assert.equal(response.total_assets, 0);
  assert.equal(response.strategy_triggers.length, 0);
  assert.ok(response.today_focus.some((item) => item.title === "真实持仓未配置"));
  assert.ok(response.data_quality.warnings.some((warning) => warning.includes("FUNDSENTINEL_PORTFOLIO_FILE")));
});

test("home service marks dashboard mock when analysis chain uses demo data", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-home-"));
  const portfolioFile = path.join(tempDir, "portfolio.json");

  try {
    writeFileSync(
      portfolioFile,
      JSON.stringify({
        generated_at: "2026-05-28T00:00:00.000Z",
        holdings: [
          {
            fund_code: "007951",
            fund_name: "真实手动持仓基金 A",
            holding_amount: 10000,
            cost_nav: 1.25,
            current_nav: 1.3
          }
        ]
      })
    );

    const response = await new HomeService(
      new PortfolioService(undefined, { portfolioFile, demoMode: false }),
      new FundAnalysisService(new SourceRegistry({ demoMode: true, enableLiveProviders: false }))
    ).getHomeDashboard("user-a");

    assert.equal(response.total_assets, 10000);
    assert.equal(response.holding_count, 1);
    assert.equal(response.is_mock, true);
    assert.equal(response.data_quality.is_mock, true);
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("demo/mock 数据")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("portfolio service reads explicit manual JSON snapshot as non-mock user-provided data", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-portfolio-"));
  const portfolioFile = path.join(tempDir, "portfolio.json");

  try {
    writeFileSync(
      portfolioFile,
      JSON.stringify({
        generated_at: "2026-05-28T00:00:00.000Z",
        holdings: [
          {
            fund_code: "007951",
            fund_name: "真实手动持仓基金 A",
            holding_amount: 10000,
            cost_nav: 1.25,
            current_nav: 1.3,
            daily_pnl: 25
          },
          {
            fund_code: "161725",
            fund_name: "真实手动持仓基金 B",
            holding_amount: "5000",
            cost_nav: "0.9",
            current_nav: "0.85",
            daily_pnl: "-10",
            unrealized_pnl_ratio: "-0.0556"
          }
        ]
      })
    );

    const snapshot = new PortfolioService(undefined, { portfolioFile, demoMode: false, now: () => "2026-05-29T00:00:00.000Z" }).getPortfolioSnapshot("user-a");

    assert.equal(snapshot.is_mock, false);
    assert.equal(snapshot.data_quality.is_mock, false);
    assert.equal(snapshot.data_quality.source, `ManualPortfolioJsonProvider:${portfolioFile}`);
    assert.equal(snapshot.total_assets, 15000);
    assert.equal(snapshot.daily_pnl, 15);
    assert.equal(snapshot.daily_pnl_ratio, 0.001);
    assert.equal(snapshot.holdings[0]?.weight, 0.6667);
    assert.equal(snapshot.holdings[1]?.weight, 0.3333);
    assert.equal(snapshot.holdings[0]?.is_mock, false);
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.startsWith("file_sha256=")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("portfolio service degrades instead of falling back to mock when configured manual JSON is invalid", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-portfolio-"));
  const portfolioFile = path.join(tempDir, "portfolio.json");

  try {
    writeFileSync(portfolioFile, JSON.stringify({ holdings: [{ fund_code: "bad-code" }] }));

    const snapshot = new PortfolioService(undefined, { portfolioFile, demoMode: false, now: () => "2026-05-29T00:00:00.000Z" }).getPortfolioSnapshot("user-a");

    assert.equal(snapshot.is_mock, false);
    assert.equal(snapshot.total_assets, 0);
    assert.equal(snapshot.holdings.length, 0);
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("手动持仓文件不可用")));
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("未回退到 mock 持仓")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("portfolio service rejects invalid manual JSON generated_at timestamps", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-portfolio-time-"));
  const portfolioFile = path.join(tempDir, "portfolio.json");

  try {
    writeFileSync(
      portfolioFile,
      JSON.stringify({
        generated_at: "2026-02-31T00:00:00.000Z",
        holdings: [
          {
            fund_code: "007951",
            fund_name: "真实手动持仓基金 A",
            holding_amount: 10000,
            cost_nav: 1.25,
            current_nav: 1.3
          }
        ]
      })
    );

    const snapshot = new PortfolioService(undefined, { portfolioFile, demoMode: false, now: () => "2026-05-29T00:00:00.000Z" }).getPortfolioSnapshot("user-a");

    assert.equal(snapshot.is_mock, false);
    assert.equal(snapshot.holdings.length, 0);
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("generated_at")));
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("未回退到 mock 持仓")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("portfolio service uses mock holdings only in explicit demo mode", () => {
  const snapshot = new PortfolioService(undefined, { portfolioFile: null, demoMode: true }).getPortfolioSnapshot("demo-user");

  assert.equal(snapshot.is_mock, true);
  assert.ok(snapshot.holdings.length > 0);
  assert.equal(snapshot.data_quality.is_mock, true);
});

test("strategy trigger service sanitizes home action language and preserves provenance", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const response: FundAnalysisResponse = {
    task_id: "home-trigger",
    fund_code: dataPack.fund_code,
    fund_name: dataPack.fund_name,
    is_mock: false,
    data_pack: {
      ...dataPack,
      data_status: "ready",
      allow_downstream_analysis: true,
      is_mock: false,
      data_quality: {
        ...dataPack.data_quality,
        is_mock: false
      }
    },
    agent_results: {},
    final_decision: {
      action: "staged_buy",
      confidence: 0.72,
      risk_level: "medium",
      summary: "internal action should not leak to home",
      reasons: [],
      risk_warnings: ["必须先核对来源和仓位失效条件，不能输出买入、卖出或仓位结论。"],
      invalidation_conditions: [],
      source_agents: ["Atlas"],
      metrics: { overall_score: 72 },
      generated_by: "Atlas",
      generated_at: "2026-05-29T00:00:00.000Z",
      is_mock: false
    },
    blackboard_snapshot: {},
    generated_at: "2026-05-29T00:00:00.000Z"
  };

  const service = new StrategyTriggerService();
  const triggers = service.buildTriggers([response]);
  const alerts = service.buildHoldingAlerts([response]);
  const focus = service.buildTodayFocus(triggers);
  const homeText = JSON.stringify({ triggers, alerts, focus });

  assert.equal(triggers[0]?.trigger_type, "observe");
  assert.equal(triggers[0]?.related_agent, "Atlas");
  assert.equal(triggers[0]?.is_mock, false);
  assert.equal(alerts[0]?.is_mock, false);
  assert.equal(focus[0]?.is_mock, false);
  assert.equal("suggested_action" in triggers[0]!, false);
  assert.equal("suggested_action" in alerts[0]!, false);
  assert.match(triggers[0]?.review_next_step ?? "", /观察主题|来源复核/);
  assert.match(alerts[0]?.review_next_step ?? "", /观察主题|来源复核/);
  assert.doesNotMatch(homeText, /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
});

test("opportunity service does not fake candidates without real data", async () => {
  const response = await new OpportunityService().getOpportunities(5);

  assert.equal(response.candidates.length, 0);
  assert.match(response.summary, /未配置真实基金候选池/);
});

test("opportunity service uses configured real universe and preserves real candidate provenance", async () => {
  const registry = new SourceRegistry({
    providers: [new RealOpportunityProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });
  const response = await new OpportunityService(undefined, new FundAnalysisService(registry), { fundUniverse: ["007951"] }).getOpportunities(5);

  assert.equal(response.is_mock, false);
  assert.equal(response.candidates.length, 1);
  assert.equal(response.candidates[0]?.fund_code, "007951");
  assert.equal(response.candidates[0]?.is_mock, false);
  assert.equal(response.candidates[0]?.review_status, "observe");
  assert.equal("action" in response.candidates[0]!, false);
  assert.equal("low_position_score" in response.candidates[0]!, false);
  assert.equal("risk_position_score" in response.candidates[0]!, false);
  assert.equal(typeof response.candidates[0]?.low_nav_score, "number");
  assert.equal(typeof response.candidates[0]?.risk_review_score, "number");
  assert.match(response.summary, /不代表交易指令/);
  assert.ok(response.candidates[0]?.key_evidence.some((item) => item.is_mock === false));
  assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
});

test("opportunity service sanitizes candidate evidence and risk text", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const analysis: FundAnalysisResponse = {
    task_id: "opportunity-sanitize",
    fund_code: dataPack.fund_code,
    fund_name: dataPack.fund_name,
    is_mock: false,
    data_pack: {
      ...dataPack,
      data_status: "ready",
      allow_downstream_analysis: true,
      is_mock: false,
      data_quality: {
        ...dataPack.data_quality,
        level: "high",
        score: 0.85,
        is_mock: false
      }
    },
    agent_results: {
      Logos: {
        agent_name: "Logos",
        agent_role: "Hard Logic Agent",
        agent_version: "0.1.0",
        task_id: "opportunity-sanitize",
        fund_code: dataPack.fund_code,
        status: "success",
        score: 72,
        confidence: 0.7,
        summary: "internal",
        evidence: [
          {
            title: "staged_buy evidence",
            source_name: "buy source",
            source_type: "policy",
            trust_level: "A",
            summary: "建议买入、卖出或仓位结论 must not leak buy sell position.",
            importance_score: 0.8,
            related_theme: null,
            published_at: null,
            url: null,
            is_mock: false
          }
        ],
        metrics: {},
        warnings: ["internal warning"],
        next_suggestions: [],
        created_at: "2026-05-29T00:00:00.000Z",
        is_mock: false
      }
    },
    final_decision: {
      action: "staged_buy",
      confidence: 0.7,
      risk_level: "medium",
      summary: "internal",
      reasons: [],
      risk_warnings: ["不能输出买入、卖出或仓位结论，也不能 leak buy sell position."],
      invalidation_conditions: [],
      source_agents: ["Atlas"],
      metrics: {
        hard_logic_score: 72,
        low_position_score: 64,
        turning_point_score: 58,
        risk_position_score: 40
      },
      generated_by: "Atlas",
      generated_at: "2026-05-29T00:00:00.000Z",
      is_mock: false
    },
    blackboard_snapshot: {},
    generated_at: "2026-05-29T00:00:00.000Z"
  };
  const fundAnalysisService = {
    analyzeFund: async () => analysis
  } as FundAnalysisService;

  const response = await new OpportunityService(undefined, fundAnalysisService, { fundUniverse: ["007951"] }).getOpportunities(1);

  assert.equal(response.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
});

test("opportunity service explicit demo mode returns only mock-marked candidates", async () => {
  const response = await new OpportunityService(undefined, undefined, { demoMode: true, enableLiveProviders: false }).getOpportunities(2);

  assert.equal(response.is_mock, true);
  assert.equal(response.data_quality.is_mock, true);
  assert.ok(response.candidates.length > 0);
  assert.ok(response.candidates.every((candidate) => candidate.is_mock));
  assert.ok(response.candidates.every((candidate) => candidate.key_evidence.every((item) => item.is_mock)));
});

test("demo mode can return demo analysis but forbids strong conclusions", async () => {
  const response = await new FundAnalysisService(new SourceRegistry({ demoMode: true, enableLiveProviders: false })).analyzeFund("007951", "demo-flow");

  assert.equal(response.data_pack.data_status, "demo");
  assert.equal(response.data_pack.allow_strong_conclusion, false);
  assert.equal(response.is_mock, true);
});

test("Argus keeps mixed demo and real provider output marked as demo", async () => {
  const registry = new SourceRegistry({
    demoMode: true,
    providers: [new RealOpportunityProvider(), new DemoLikeProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });
  const response = await new FundAnalysisService(registry).analyzeFund("007951", "mixed-demo-flow");

  assert.equal(response.is_mock, true);
  assert.equal(response.data_pack.is_mock, true);
  assert.equal(response.agent_results.Argus?.is_mock, true);
  assert.equal(response.data_pack.data_status, "demo");
  assert.equal(response.data_pack.data_quality.is_mock, true);
  assert.equal(response.data_pack.allow_strong_conclusion, false);
  assert.ok(response.data_pack.data_sources.some((source) => source.is_demo));
  assert.ok(response.data_pack.data_sources.some((source) => source.is_demo === false));
  assert.ok(response.data_pack.data_quality_report.warnings.some((warning) => warning.includes("demo fixture")));
});

test("public fund analysis sanitizes full demo DAG action language", async () => {
  const response = await new FundAnalysisService(new SourceRegistry({ demoMode: true, enableLiveProviders: false })).analyzeFundPublic("007951", "demo-public-flow");
  const payload = JSON.stringify(response);

  assert.equal(response.is_mock, true);
  assert.equal(response.data_pack.data_status, "demo");
  assert.equal("final_decision" in response, false);
  assert.equal("blackboard_snapshot" in response, false);
  assert.equal("action" in response.final_review, false);
  assert.equal("source_composition" in response.data_pack.data_quality_report, true);
  assert.equal("source_comreview" in response.data_pack.data_quality_report, false);
  assert.equal(response.agent_results.Aegis?.agent_role, "Risk Review Agent");
  assert.equal(response.agent_results.Nadir?.agent_role, "Valuation Review Agent");
  assert.doesNotMatch(payload, /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位|重仓|加仓|减仓/iu);
});

test("public fund analysis filters action-like final review metric keys", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const response: FundAnalysisResponse = {
    task_id: "public-final-metrics",
    fund_code: dataPack.fund_code,
    fund_name: dataPack.fund_name,
    is_mock: true,
    data_pack: dataPack,
    agent_results: {},
    final_decision: {
      action: "observe",
      confidence: 0.5,
      risk_level: "medium",
      summary: "internal final decision",
      reasons: [],
      risk_warnings: [],
      invalidation_conditions: [],
      source_agents: ["Atlas"],
      metrics: {
        overall_score: 50,
        hard_logic_score: 48,
        low_position_score: 42,
        risk_position_score: 36,
        action: 1,
        buy: 1,
        sell: 0,
        position: 1
      },
      generated_by: "Atlas",
      generated_at: "2026-05-29T00:00:00.000Z",
      is_mock: true
    },
    blackboard_snapshot: {},
    generated_at: "2026-05-29T00:00:00.000Z"
  };

  const publicResponse = new FundAnalysisService().presentPublicFundAnalysis(response);

  assert.equal("action" in publicResponse.final_review.metrics, false);
  assert.equal("buy" in publicResponse.final_review.metrics, false);
  assert.equal("sell" in publicResponse.final_review.metrics, false);
  assert.equal("position" in publicResponse.final_review.metrics, false);
  assert.equal(publicResponse.final_review.metrics.low_nav_score, 42);
  assert.equal(publicResponse.final_review.metrics.risk_review_score, 36);
});

test("SourceRegistry lists real providers and demo fixture provider", () => {
  const sources = new SourceRegistry(false).listSources();

  assert.ok(sources.some((source) => source.source_id === "csrc-fund-disclosure" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "eastmoney-fund" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "eastmoney-nav-history" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "cmfchina-fund-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "ndrc-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "harvestfund-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "fullgoal-fund-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "hkex-official" && source.trust_level === "A" && !source.is_demo));
  assert.ok(sources.some((source) => source.source_id === "demo-fixture" && source.is_demo && !source.enabled));
});

test("SourceRegistry has runtime providers for every implemented catalog source", () => {
  const runtimeSourceIds = new Set(new SourceRegistry({ enableLiveProviders: false }).listSources().map((source) => source.source_id));
  const missingRuntimeSources = listDataSourceCatalog()
    .filter((source) => source.integration_status === "implemented")
    .map((source) => source.source_id)
    .filter((sourceId) => !runtimeSourceIds.has(sourceId));

  assert.deepEqual(missingRuntimeSources, []);
});

test("data-source catalog descriptions stay in data-coverage language", () => {
  const descriptionText = listDataSourceCatalog()
    .map((source) => [source.notes, source.legal_note, source.access_method].join("\n"))
    .join("\n");

  assert.doesNotMatch(descriptionText, /trading access|trading signals|investment advice|\badvice\b|buy\/sell|brokerage|payment (?:account|path|feature)|transaction features/iu);
  assert.doesNotMatch(descriptionText, /买卖结论|交易信号|交易功能|交易指令|账户连接|账户授权|券商|支付宝/u);
});

test("runtime data source descriptions stay in data-coverage language", () => {
  const descriptionText = new SourceRegistry({ enableLiveProviders: false })
    .listSources()
    .map((source) => [source.notes, source.access_method, source.freshness_policy].join("\n"))
    .join("\n");

  assert.doesNotMatch(descriptionText, /trading access|trading signals|investment advice|\badvice\b|buy\/sell|brokerage|payment (?:account|path|feature)|transaction features/iu);
  assert.doesNotMatch(descriptionText, /买卖结论|交易信号|交易功能|交易指令|账户连接|账户授权|券商|支付宝/u);
});

test("SourceRegistry coverage matrix distinguishes implemented and gap requirements", () => {
  const coverage = new SourceRegistry({ enableLiveProviders: false }).coverageMatrix();
  const officialReports = coverage.find((item) => item.requirement === "official_fund_reports");
  const officialCurrentNav = coverage.find((item) => item.requirement === "official_current_nav");
  const officialNavHistory = coverage.find((item) => item.requirement === "official_nav_history");
  const navHistory = coverage.find((item) => item.requirement === "nav_history");
  const macroData = coverage.find((item) => item.requirement === "macro_data");
  const social = coverage.find((item) => item.requirement === "social_sentiment");
  const industryNews = coverage.find((item) => item.requirement === "industry_news");

  assert.ok(officialReports?.source_ids.includes("csrc-fund-disclosure"));
  assert.ok(officialReports?.implemented_source_ids.includes("csrc-fund-disclosure"));
  assert.equal(officialReports?.implemented_source_ids.includes("fund-company-report"), false);
  assert.ok(officialReports?.coordinator_source_ids.includes("fund-company-report"));
  assert.ok(officialReports?.implemented_source_ids.includes("fullgoal-fund-official"));
  assert.ok(officialReports?.implemented_source_ids.includes("sec-edgar"));
  assert.equal(officialReports?.gap_level, "partial");
  assert.ok(officialCurrentNav?.source_ids.includes("cmfchina-fund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("efund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("chinaamc-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("harvestfund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("fullgoal-fund-official"));
  assert.equal(officialCurrentNav?.gap_level, "covered");
  assert.ok(officialNavHistory?.source_ids.includes("cmfchina-fund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("efund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("chinaamc-official"));
  assert.ok(officialNavHistory?.source_ids.includes("harvestfund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("fullgoal-fund-official"));
  assert.equal(officialNavHistory?.gap_level, "covered");
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-fund"));
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-nav-history"));
  assert.ok(macroData?.source_ids.includes("stats-gov-cn"));
  assert.ok(macroData?.source_ids.includes("mof-official"));
  assert.ok(macroData?.source_ids.includes("safe-official"));
  assert.ok(macroData?.source_ids.includes("pbc-official"));
  assert.ok(macroData?.source_ids.includes("fred-official"));
  assert.ok(macroData?.source_ids.includes("world-bank-api"));
  assert.ok(macroData?.source_ids.includes("imf-data-api"));
  assert.ok(macroData?.source_ids.includes("oecd-data-api"));
  assert.ok(macroData?.source_ids.includes("eurostat-api"));
  assert.ok(macroData?.implemented_source_ids.includes("stats-gov-cn"));
  assert.ok(macroData?.implemented_source_ids.includes("mof-official"));
  assert.ok(macroData?.implemented_source_ids.includes("safe-official"));
  assert.ok(macroData?.implemented_source_ids.includes("pbc-official"));
  assert.ok(macroData?.implemented_source_ids.includes("fred-official"));
  assert.ok(macroData?.implemented_source_ids.includes("world-bank-api"));
  assert.ok(macroData?.implemented_source_ids.includes("imf-data-api"));
  assert.ok(macroData?.implemented_source_ids.includes("oecd-data-api"));
  assert.ok(macroData?.implemented_source_ids.includes("eurostat-api"));
  assert.equal(macroData?.gap_level, "covered");
  assert.ok(industryNews?.implemented_source_ids.includes("ndrc-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("amac-public-fund-data"));
  assert.ok(industryNews?.implemented_source_ids.includes("csrc-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("sse-szse-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("miit-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("hkex-official"));
  assert.equal(industryNews?.gap_level, "covered");
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

test("SourceRegistry health recovers after a later provider success", async () => {
  const provider = new RecoveringProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 0, retryCount: 0 });
  const input = { fund_code: "007951", required_data: ["fund_meta"], demo_mode: false };

  const first = (await registry.fetchAll(input))[0];
  const second = (await registry.fetchAll(input))[0];
  const health = registry.health().find((source) => source.source_id === "recovering-provider");

  assert.equal(first.success, false);
  assert.equal(second.success, true);
  assert.equal(health?.failure_count, 1);
  assert.equal(health?.consecutive_failure_count, 0);
  assert.equal(health?.health_status, "healthy");
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
  assert.doesNotMatch(JSON.stringify(gap), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
  assert.ok(Array.isArray(gap.failed_source_details));
  assert.equal(gap.allow_strong_conclusion, false);
  assert.equal(gap.source_composition.official_core_coverage.current_nav, false);
  assert.equal(gap.source_composition.official_core_coverage.nav_history, false);
  assert.equal(gap.source_composition.official_core_coverage.fund_reports, false);
  assert.ok(gap.acquisition_solutions[0].engineering_tasks.length > 0);
  assert.ok(gap.acquisition_solutions[0].manual_workaround.length > 0);
  assert.ok(manualPlan.solutions[0].engineering_tasks.length > 0);
  assert.ok(manualPlan.required_portfolio_json_fields.includes("holdings[].holding_amount"));
  assert.ok(manualPlan.required_report_manifest_fields.includes("pdf_sha256"));
  assert.equal(manualPlan.report_manifest_filename, "{fund_code}.reports.json");
  assert.ok(manualPlan.solutions.some((solution) => solution.proposed_actions.some((action) => action.includes("FUNDSENTINEL_PORTFOLIO_FILE"))));
  assert.ok(manualPlan.solutions.some((solution) => solution.proposed_actions.some((action) => action.includes("FUNDSENTINEL_MANUAL_REPORT_DIR"))));
  assert.ok(manualPlan.warnings.some((warning) => warning.includes("官方报告 PDF manifest 不得标记为自动抓取")));
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

class RealOpportunityProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("real-opportunity-provider"),
      source_name: "Real Opportunity Fixture Provider",
      source_type: "fund_company",
      trust_level: "A",
      priority: 1
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "real-opportunity-provider",
      source_name: "Real Opportunity Fixture Provider",
      source_type: "fund_company",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "真实机会测试基金",
        fund_type: "mixed",
        current_nav: 1.08,
        daily_return: 0.42,
        nav_history: [1.4, 1.28, 1.16, 1.08, 1.02, 1, 1.01, 1.03, 1.05, 1.08],
        nav_history_dates: ["2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-27", "2026-05-28"],
        portfolio_holdings: ["新能源设备(300001)", "电力运营(600001)", "储能系统(300002)"],
        holdings_as_of: "2026-03-31",
        holdings_source: "official fixture",
        themes: ["新能源", "电力"],
        policy_signals: ["2026-05-22 国家发展改革委新型电力系统政策发布"],
        news_summaries: ["国家发展改革委：能源结构调整公开新闻（2026-05-22）"],
        social_sentiment_score: 0.4
      },
      raw_reference: "https://official.example.test/fund/007951",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class DemoLikeProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("demo-like-provider"),
      source_name: "Demo Like Fixture Provider",
      source_type: "demo_fixture",
      trust_level: "DEMO",
      priority: 2,
      is_demo: true
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.demo_mode;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "demo-like-provider",
      source_name: "Demo Like Fixture Provider",
      source_type: "demo_fixture",
      trust_level: "DEMO",
      data_status: "demo",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "Demo Fixture Fund",
        fund_type: "mixed",
        current_nav: 0.99,
        daily_return: 0.01,
        nav_history: [0.9, 0.95, 0.99],
        nav_history_dates: ["2026-05-26", "2026-05-27", "2026-05-28"],
        themes: ["demo-theme"],
        policy_signals: ["demo policy"],
        news_summaries: ["demo news"],
        social_sentiment_score: 0.5
      },
      raw_reference: "demo://fixture",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "unknown",
      warnings: ["demo fixture data"],
      error: null,
      is_demo: true
    };
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

class RecoveringProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;

  sourceInfo(): DataSourceInfo {
    return sourceInfo("recovering-provider");
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    return providerResult("recovering-provider", this.callCount > 1);
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
