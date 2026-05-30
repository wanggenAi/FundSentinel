import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
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
import { AtlasOrchestrationService, DataSourceService, FundAnalysisService, HomeService, MockDataService, OpportunityService, PortfolioService, StrategyTriggerService } from "../src/services/index.js";

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
            fund_name: "真实手动持仓基金 A must buy 保证收益 token=home-secret",
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

test("home service surfaces degraded analysis gaps when downstream analysis is allowed but strong conclusions are blocked", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-home-degraded-"));
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
      new FundAnalysisService(new SourceRegistry({ providers: [new RealOpportunityProvider()], cacheTtlMs: 0, retryCount: 0 }))
    ).getHomeDashboard("user-a");

    assert.equal(response.is_mock, false);
    assert.equal(response.holding_count, 1);
    assert.equal(response.strategy_triggers.length, 1);
    assert.equal(response.data_quality.score < 0.68, true);
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("Argus 未允许强结论")));
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("official_fund_reports")));
    assert.ok(response.today_focus.some((item) => item.title === "证据降级复核" && item.related_funds.includes("007951")));
    assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|must buy|guaranteed|risk[-\s]?free|买入|卖出|仓位|保证收益|无风险|home-secret/iu);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("home service degrades individual analysis failures without dropping the dashboard", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-home-partial-failure-"));
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
          },
          {
            fund_code: "161725",
            fund_name: "真实手动持仓基金 B",
            holding_amount: 5000,
            cost_nav: 0.9,
            current_nav: 0.85
          }
        ]
      })
    );

    const response = await new HomeService(
      new PortfolioService(undefined, { portfolioFile, demoMode: false }),
      new PartiallyFailingFundAnalysisService(new Set(["161725"]))
    ).getHomeDashboard("user-a");
    const payload = JSON.stringify(response);

    assert.equal(response.is_mock, true);
    assert.equal(response.holding_count, 2);
    assert.equal(response.total_assets, 15000);
    assert.equal(response.data_quality.level, "low");
    assert.equal(response.data_quality.score, 0.35);
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("161725 首页分析失败")));
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("requires evidence review")));
    assert.ok(response.data_quality.warnings.some((warning) => warning.includes("token=[REDACTED]")));
    assert.ok(response.today_focus.some((item) => item.title === "分析链路失败" && item.related_funds.includes("161725")));
    assert.ok(response.strategy_triggers.some((trigger) => trigger.fund_code === "007951"));
    assert.doesNotMatch(payload, /must buy|guaranteed|risk[-\s]?free|保证收益|无风险|home-failure-secret/iu);
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
        user_id: "other-token=portfolio-user-secret guaranteed must buy",
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
    assert.equal(snapshot.manual_import_audit?.file_path, portfolioFile);
    assert.equal(snapshot.manual_import_audit?.file_sha256.length, 64);
    assert.ok((snapshot.manual_import_audit?.file_size_bytes ?? 0) > 0);
    assert.match(snapshot.manual_import_audit?.file_mtime ?? "", /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(snapshot.manual_import_audit?.imported_at, "2026-05-29T00:00:00.000Z");
    assert.equal(snapshot.manual_import_audit?.generated_at, "2026-05-28T00:00:00.000Z");
    assert.equal(snapshot.manual_import_audit?.holding_count, 2);
    assert.equal(snapshot.holdings[0]?.weight, 0.6667);
    assert.equal(snapshot.holdings[1]?.weight, 0.3333);
    assert.equal(snapshot.holdings[0]?.is_mock, false);
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.startsWith("file_sha256=")));
    assert.doesNotMatch(JSON.stringify(snapshot.data_quality), /must buy|guaranteed|portfolio-user-secret/iu);
    assert.match(JSON.stringify(snapshot.data_quality), /token=\[REDACTED\]/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("home service exposes sanitized manual portfolio import audit", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-home-audit-"));
  const portfolioFile = path.join(tempDir, "portfolio-token=portfolio-secret-guaranteed.json");

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
      new PortfolioService(undefined, { portfolioFile, demoMode: false, now: () => "2026-05-29T00:00:00.000Z" }),
      new FundAnalysisService(new SourceRegistry({ enableLiveProviders: false }))
    ).getHomeDashboard("user-a");
    const payload = JSON.stringify(response);

    assert.equal(response.manual_import_audit?.holding_count, 1);
    assert.equal(response.manual_import_audit?.file_sha256.length, 64);
    assert.equal(response.manual_import_audit?.imported_at, "2026-05-29T00:00:00.000Z");
    assert.match(response.manual_import_audit?.file_path ?? "", /token=\[REDACTED\]/u);
    assert.doesNotMatch(payload, /portfolio-secret|guaranteed|must buy/iu);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("portfolio service degrades instead of falling back to mock when configured manual JSON is invalid", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "fundsentinel-portfolio-"));
  const portfolioFile = path.join(tempDir, "portfolio-token=portfolio-secret-guaranteed.json");

  try {
    const snapshot = new PortfolioService(undefined, { portfolioFile, demoMode: false, now: () => "2026-05-29T00:00:00.000Z" }).getPortfolioSnapshot("user-a");
    const payload = JSON.stringify(snapshot);

    assert.equal(snapshot.is_mock, false);
    assert.equal(snapshot.total_assets, 0);
    assert.equal(snapshot.holdings.length, 0);
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("手动持仓文件不可用")));
    assert.ok(snapshot.data_quality.warnings.some((warning) => warning.includes("未回退到 mock 持仓")));
    assert.doesNotMatch(payload, /must buy|guaranteed|portfolio-secret/iu);
    assert.match(payload, /token=\[REDACTED\]/u);
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
      risk_warnings: ["必须先核对来源和仓位失效条件，不能输出买入、卖出或仓位结论；不得承诺保证收益、无风险或 must buy。"],
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
  assert.doesNotMatch(homeText, /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|must buy|guaranteed|risk[-\s]?free|买入|卖出|仓位|保证收益|无风险/iu);
});

test("atlas orchestration service sanitizes public agent catalog", () => {
  const service = new AtlasOrchestrationService();
  const internalAgents = service.listAgents();
  const publicAgents = service.listPublicAgents();
  const publicText = JSON.stringify(publicAgents);

  assert.ok(internalAgents.some((agent) => JSON.stringify(agent).includes("trial_buy")));
  assert.equal(publicAgents.find((agent) => agent.name === "Aegis")?.role, "Risk Review Agent");
  assert.equal(publicAgents.find((agent) => agent.name === "Nadir")?.role, "Valuation Review Agent");
  assert.doesNotMatch(publicText, /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位|保证收益|无风险/iu);
});

test("opportunity service does not fake candidates without real data", async () => {
  const response = await new OpportunityService().getOpportunities(5);

  assert.equal(response.candidates.length, 0);
  assert.equal(response.universe_audit.source_type, "unconfigured");
  assert.equal(response.universe_audit.source_name, "unconfigured");
  assert.equal(response.universe_audit.selected_count, 0);
  assert.equal(response.universe_audit.requested_limit, 5);
  assert.deepEqual(response.universe_audit.selected_fund_codes, []);
  assert.equal(response.universe_audit.is_mock, false);
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
  assert.equal(response.universe_audit.source_type, "configured_env");
  assert.equal(response.universe_audit.source_name, "FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE");
  assert.equal(response.universe_audit.configured_count, 1);
  assert.equal(response.universe_audit.selected_count, 1);
  assert.deepEqual(response.universe_audit.selected_fund_codes, ["007951"]);
  assert.equal(response.universe_audit.is_mock, false);
  assert.equal(response.candidates.length, 1);
  assert.equal(response.candidates[0]?.fund_code, "007951");
  assert.equal(response.candidates[0]?.is_mock, false);
  assert.equal(response.candidates[0]?.review_status, "evidence_review");
  assert.equal("action" in response.candidates[0]!, false);
  assert.equal("low_position_score" in response.candidates[0]!, false);
  assert.equal("risk_position_score" in response.candidates[0]!, false);
  assert.equal(typeof response.candidates[0]?.low_nav_score, "number");
  assert.equal(typeof response.candidates[0]?.risk_review_score, "number");
  assert.match(response.summary, /证据补齐优先级/);
  assert.ok(response.candidates[0]?.reason_summary.includes("Argus 未允许强结论"));
  assert.ok(response.candidates[0]?.reason_summary.includes("official_fund_reports"));
  assert.ok(response.data_quality.warnings.some((warning) => warning.includes("Argus 未允许强结论")));
  assert.ok(response.data_quality.warnings.some((warning) => warning.includes("official_fund_reports")));
  assert.ok(response.candidates[0]?.key_evidence.some((item) => item.is_mock === false));
  assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位/iu);
});

test("opportunity service skips failed fund analyses while preserving successful candidates", async () => {
  const response = await new OpportunityService(undefined, new PartiallyFailingFundAnalysisService(new Set(["161725"])), {
    fundUniverse: ["007951", "161725"]
  }).getOpportunities(5);
  const payload = JSON.stringify(response);

  assert.equal(response.is_mock, true);
  assert.equal(response.candidates.length, 1);
  assert.equal(response.candidates[0]?.fund_code, "007951");
  assert.equal(response.data_quality.level, "low");
  assert.ok(response.data_quality.score <= 0.4);
  assert.ok(response.data_quality.warnings.some((warning) => warning.includes("161725 候选分析失败")));
  assert.match(response.summary, /候选复核池/);
  assert.doesNotMatch(payload, /must buy|guaranteed|risk[-\s]?free|保证收益|无风险|home-failure-secret/iu);
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
            summary: "建议买入、卖出或仓位结论 must not leak buy sell position; guaranteed returns and risk-free yield are forbidden.",
            importance_score: 0.8,
            related_theme: "must buy guaranteed opportunity token=opportunity-theme-secret",
            published_at: null,
            url: "https://evidence.example.test/source?api_key=opportunity-url-secret&access_token=opportunity-token-secret",
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
      risk_warnings: ["不能输出买入、卖出或仓位结论，也不能 leak buy sell position, must buy, guaranteed returns or risk-free claims."],
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
  assert.match(response.candidates[0]?.key_evidence[0]?.url ?? "", /api_key=\[REDACTED\]/u);
  assert.match(response.candidates[0]?.key_evidence[0]?.url ?? "", /access_token=\[REDACTED\]/u);
  assert.match(response.candidates[0]?.key_evidence[0]?.related_theme ?? "", /must review/u);
  assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|must buy|guaranteed|risk[-\s]?free|买入|卖出|仓位|保证收益|无风险|opportunity-secret/iu);
  assert.doesNotMatch(JSON.stringify(response), /opportunity-url-secret|opportunity-token-secret|opportunity-theme-secret/iu);
});

test("opportunity service explicit demo mode returns only mock-marked candidates", async () => {
  const response = await new OpportunityService(undefined, undefined, { demoMode: true, enableLiveProviders: false }).getOpportunities(2);

  assert.equal(response.is_mock, true);
  assert.equal(response.data_quality.is_mock, true);
  assert.equal(response.universe_audit.source_type, "demo_fixture");
  assert.equal(response.universe_audit.source_name, "MockDataService demo fund universe");
  assert.equal(response.universe_audit.selected_count, 2);
  assert.equal(response.universe_audit.is_mock, true);
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

test("public fund analysis surfaces degraded strong-conclusion blocks in final review", async () => {
  const registry = new SourceRegistry({
    providers: [new RealOpportunityProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });
  const response = await new FundAnalysisService(registry).analyzeFundPublic("007951", "degraded-public-flow");

  assert.equal(response.is_mock, false);
  assert.equal(response.data_pack.data_status, "partial");
  assert.equal(response.data_pack.allow_downstream_analysis, true);
  assert.equal(response.data_pack.allow_strong_conclusion, false);
  assert.equal(response.final_review.review_status, "evidence_review");
  assert.match(response.final_review.summary, /Argus 未允许强结论/);
  assert.match(response.final_review.summary, /official_fund_reports/);
  assert.ok(response.traceability.data_gap_report?.missing_data.includes("official_fund_reports"));
  assert.ok(response.traceability.acquisition_solutions.some((solution) => solution.engineering_tasks.length > 0));
  for (const agentName of ["Logos", "Nadir", "Vega", "Aegis"] as const) {
    const result = response.agent_results[agentName];
    assert.equal(result?.status, "warning");
    assert.ok((result?.confidence ?? 1) <= 0.55);
    assert.ok(result?.warnings.some((warning) => warning.includes("Argus 未允许强结论")));
  }
  assert.equal("action" in (response.agent_results.Aegis?.metrics ?? {}), false);
  assert.doesNotMatch(JSON.stringify(response), /trial_buy|staged_buy|add_position|\b(buy|sell|position)\b|买入|卖出|仓位|重仓|加仓|减仓/iu);
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
      reasons: ["must buy because guaranteed returns should not leak"],
      risk_warnings: ["risk-free claim 和保证收益必须被清洗"],
      invalidation_conditions: ["必须卖出或加仓这类条件不能出现在公开响应"],
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
  assert.doesNotMatch(JSON.stringify(publicResponse.final_review), /must buy|guaranteed|risk[-\s]?free|保证收益|必须卖出|加仓/iu);
});

test("public fund analysis sanitizes dynamic metric keys and sensitive metric values", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const response: FundAnalysisResponse = {
    task_id: "public-agent-metrics",
    fund_code: dataPack.fund_code,
    fund_name: dataPack.fund_name,
    is_mock: true,
    data_pack: dataPack,
    agent_results: {
      Logos: {
        task_id: "public-agent-metrics",
        agent_name: "Logos",
        agent_role: "Evidence Agent",
        status: "warning",
        score: 50,
        confidence: 0.4,
        summary: "must buy with guaranteed returns",
        evidence: [],
        metrics: {
          buy_signal: "must buy now",
          nested: {
            risk_position_score: 42,
            api_key: "metric-secret"
          }
        },
        warnings: ["risk-free 保证收益"],
        next_suggestions: [],
        generated_at: "2026-05-29T00:00:00.000Z",
        is_mock: true
      }
    },
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
        overall_score: 50
      },
      generated_by: "Atlas",
      generated_at: "2026-05-29T00:00:00.000Z",
      is_mock: true
    },
    blackboard_snapshot: {},
    generated_at: "2026-05-29T00:00:00.000Z"
  };

  const publicResponse = new FundAnalysisService().presentPublicFundAnalysis(response);
  const metrics = publicResponse.agent_results.Logos?.metrics as Record<string, unknown>;
  const nested = metrics.nested as Record<string, unknown>;
  const payload = JSON.stringify(publicResponse);

  assert.equal(metrics.review_signal, "must review now");
  assert.equal(nested.risk_review_score, 42);
  assert.equal(nested.api_key, "[REDACTED]");
  assert.doesNotMatch(payload, /buy_signal|risk_position_score|metric-secret|must buy|guaranteed|risk[-\s]?free|保证收益/iu);
});

test("public fund analysis sanitizes agent evidence URLs and related themes", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const response: FundAnalysisResponse = {
    task_id: "public-agent-evidence",
    fund_code: dataPack.fund_code,
    fund_name: dataPack.fund_name,
    is_mock: true,
    data_pack: dataPack,
    agent_results: {
      Argus: {
        task_id: "public-agent-evidence",
        agent_name: "Argus",
        agent_role: "Data Acquisition Agent",
        agent_version: "0.1.0",
        fund_code: dataPack.fund_code,
        status: "warning",
        score: 40,
        confidence: 0.4,
        summary: "provider evidence",
        evidence: [
          {
            title: "Provider raw evidence",
            source_name: "Provider",
            source_type: "industry_data",
            trust_level: "B",
            summary: "raw reference contains api_key=evidence-summary-secret",
            importance_score: 0.5,
            related_theme: "must buy guaranteed theme token=theme-secret",
            published_at: "2026-05-29T00:00:00.000Z",
            url: "https://provider.example.test/detail?api_key=evidence-url-secret&access_token=evidence-token-secret",
            is_mock: false
          }
        ],
        metrics: {},
        warnings: [],
        next_suggestions: [],
        created_at: "2026-05-29T00:00:00.000Z",
        is_mock: true
      }
    },
    final_decision: {
      action: "observe",
      confidence: 0.4,
      risk_level: "medium",
      summary: "observe",
      reasons: [],
      risk_warnings: [],
      invalidation_conditions: [],
      source_agents: ["Argus"],
      metrics: {
        overall_score: 40,
        hard_logic_score: 40,
        low_position_score: 40,
        risk_position_score: 40
      },
      generated_by: "Atlas",
      generated_at: "2026-05-29T00:00:00.000Z",
      is_mock: true
    },
    blackboard_snapshot: {},
    generated_at: "2026-05-29T00:00:00.000Z"
  };

  const publicResponse = new FundAnalysisService().presentPublicFundAnalysis(response);
  const evidence = publicResponse.agent_results.Argus?.evidence[0];
  const payload = JSON.stringify(publicResponse);

  assert.match(evidence?.url ?? "", /api_key=\[REDACTED\]/u);
  assert.match(evidence?.url ?? "", /access_token=\[REDACTED\]/u);
  assert.match(evidence?.related_theme ?? "", /must review/u);
  assert.match(evidence?.summary ?? "", /api_key=\[REDACTED\]/u);
  assert.doesNotMatch(payload, /evidence-url-secret|evidence-token-secret|theme-secret|evidence-summary-secret|must buy|guaranteed/iu);
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
  const catalog = listDataSourceCatalog();
  const implementedSourceIds = catalog.filter((source) => source.integration_status === "implemented").map((source) => source.source_id);
  const manualSourceIds = catalog.filter((source) => source.integration_status === "manual").map((source) => source.source_id);
  const missingRuntimeSources = implementedSourceIds.filter((sourceId) => !runtimeSourceIds.has(sourceId));

  assert.deepEqual(missingRuntimeSources, []);
  assert.equal(implementedSourceIds.includes("manual-csv-import"), false);
  assert.equal(implementedSourceIds.includes("manual-official-report-import"), false);
  assert.deepEqual(manualSourceIds, ["manual-csv-import", "manual-official-report-import"]);
  assert.ok(manualSourceIds.every((sourceId) => runtimeSourceIds.has(sourceId)));
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
  const fundMeta = coverage.find((item) => item.requirement === "fund_meta");
  const currentNav = coverage.find((item) => item.requirement === "current_nav");
  const officialReports = coverage.find((item) => item.requirement === "official_fund_reports");
  const officialCurrentNav = coverage.find((item) => item.requirement === "official_current_nav");
  const officialNavHistory = coverage.find((item) => item.requirement === "official_nav_history");
  const navHistory = coverage.find((item) => item.requirement === "nav_history");
  const holdings = coverage.find((item) => item.requirement === "holdings");
  const fundReports = coverage.find((item) => item.requirement === "fund_reports");
  const macroData = coverage.find((item) => item.requirement === "macro_data");
  const benchmark = coverage.find((item) => item.requirement === "benchmark");
  const social = coverage.find((item) => item.requirement === "social_sentiment");
  const industryNews = coverage.find((item) => item.requirement === "industry_news");

  assert.equal(fundMeta?.implemented_source_ids.includes("manual-csv-import"), false);
  assert.ok(fundMeta?.manual_source_ids.includes("manual-csv-import"));
  assert.ok(fundMeta?.planned_source_ids.includes("fund-company-site-adapters"));
  assert.equal(fundMeta?.implemented_authoritative_source_ids.includes("fund-company-site-adapters"), false);
  assert.ok(fundMeta?.implemented_authoritative_source_ids.includes("csrc-public-fund-products"));
  assert.equal(currentNav?.implemented_source_ids.includes("manual-csv-import"), false);
  assert.ok(currentNav?.manual_source_ids.includes("manual-csv-import"));
  assert.ok(currentNav?.planned_source_ids.includes("fund-company-site-adapters"));
  assert.equal(currentNav?.implemented_authoritative_source_ids.includes("fund-company-site-adapters"), false);
  assert.ok(officialReports?.source_ids.includes("csrc-fund-disclosure"));
  assert.ok(officialReports?.implemented_source_ids.includes("csrc-fund-disclosure"));
  assert.equal(officialReports?.implemented_source_ids.includes("fund-company-report"), false);
  assert.equal(officialReports?.source_ids.includes("manual-official-report-import"), false);
  assert.equal(officialReports?.implemented_source_ids.includes("manual-official-report-import"), false);
  assert.equal(officialReports?.manual_source_ids.includes("manual-official-report-import"), false);
  assert.ok(officialReports?.manual_workaround_source_ids.includes("manual-official-report-import"));
  assert.ok(officialReports?.coordinator_source_ids.includes("fund-company-report"));
  assert.ok(officialReports?.implemented_source_ids.includes("fullgoal-fund-official"));
  assert.ok(officialReports?.implemented_source_ids.includes("sec-edgar"));
  assert.ok(officialReports?.implemented_authoritative_source_ids.includes("csrc-fund-disclosure"));
  assert.equal(officialReports?.implemented_authoritative_source_ids.includes("fund-company-report"), false);
  assert.ok(officialReports?.planned_source_ids.includes("fund-company-site-adapters"));
  assert.equal(officialReports?.gap_level, "partial");
  assert.ok(officialCurrentNav?.source_ids.includes("cmfchina-fund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("efund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("chinaamc-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("harvestfund-official"));
  assert.ok(officialCurrentNav?.source_ids.includes("fullgoal-fund-official"));
  assert.equal(officialCurrentNav?.manual_source_ids.includes("manual-csv-import"), false);
  assert.ok(officialCurrentNav?.manual_workaround_source_ids.includes("manual-csv-import"));
  assert.equal(officialCurrentNav?.implemented_authoritative_source_ids.includes("fund-company-site-adapters"), false);
  assert.equal(officialCurrentNav?.gap_level, "covered");
  assert.ok(officialNavHistory?.source_ids.includes("cmfchina-fund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("efund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("chinaamc-official"));
  assert.ok(officialNavHistory?.source_ids.includes("harvestfund-official"));
  assert.ok(officialNavHistory?.source_ids.includes("fullgoal-fund-official"));
  assert.equal(officialNavHistory?.manual_source_ids.includes("manual-csv-import"), false);
  assert.ok(officialNavHistory?.manual_workaround_source_ids.includes("manual-csv-import"));
  assert.equal(officialNavHistory?.implemented_authoritative_source_ids.includes("fund-company-site-adapters"), false);
  assert.equal(officialNavHistory?.gap_level, "covered");
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-fund"));
  assert.ok(navHistory?.implemented_source_ids.includes("eastmoney-nav-history"));
  assert.equal(navHistory?.implemented_source_ids.includes("manual-csv-import"), false);
  assert.ok(navHistory?.manual_source_ids.includes("manual-csv-import"));
  assert.equal(holdings?.implemented_source_ids.includes("manual-csv-import"), false);
  assert.ok(holdings?.manual_source_ids.includes("manual-csv-import"));
  assert.equal(fundReports?.implemented_source_ids.includes("manual-official-report-import"), false);
  assert.ok(fundReports?.manual_source_ids.includes("manual-official-report-import"));
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
  assert.equal(benchmark?.gap_level, "requires_license");
  assert.equal(benchmark?.coverage_status, "licensed_only");
  assert.ok(benchmark?.requires_license_source_ids.includes("csi-index"));
  assert.ok(benchmark?.requires_license_source_ids.includes("commercial-terminal-api"));
  assert.deepEqual(benchmark?.requires_license_source_ids, benchmark?.needs_license_source_ids);
  assert.deepEqual(benchmark?.implemented_source_ids, []);
  assert.match(benchmark?.notes ?? "", /授权数据源/);
  assert.ok(social?.blocked_source_ids.includes("social-sentiment-sources"));
  assert.equal(social?.implemented_authoritative_source_ids.length, 0);
  assert.ok(industryNews?.implemented_source_ids.includes("ndrc-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("amac-public-fund-data"));
  assert.ok(industryNews?.implemented_source_ids.includes("csrc-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("sse-szse-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("miit-official"));
  assert.ok(industryNews?.implemented_source_ids.includes("hkex-official"));
  assert.equal(industryNews?.gap_level, "covered");
  assert.equal(social?.gap_level, "missing");
  assert.equal(social?.coverage_status, "missing");
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

test("SourceRegistry health counts only live cache entries for the exact provider", async () => {
  const registry = new SourceRegistry({
    providers: [new CountingProvider("cache-provider"), new CountingProvider("cache-provider-extra")],
    cacheTtlMs: 60_000,
    retryCount: 0
  });
  const input = { fund_code: "007951", required_data: ["fund_meta"], demo_mode: false };

  await registry.fetchAll(input);
  const cache = (registry as unknown as { resultCache: Map<string, { sourceId: string; expiresAt: number }> }).resultCache;
  for (const cached of cache.values()) {
    if (cached.sourceId === "cache-provider-extra") cached.expiresAt = Date.now() - 1;
  }

  const health = registry.health();
  const primary = health.find((source) => source.source_id === "cache-provider");
  const similarlyNamed = health.find((source) => source.source_id === "cache-provider-extra");

  assert.equal(primary?.cache_entries, 1);
  assert.equal(similarlyNamed?.cache_entries, 0);
  assert.equal([...cache.values()].some((cached) => cached.sourceId === "cache-provider-extra"), false);
});

test("SourceRegistry cache hits do not hide later live provider failures", async () => {
  const provider = new CountingProvider("cache-health-provider");
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0 });
  const input = { fund_code: "007951", required_data: ["fund_meta"], demo_mode: false };

  const first = (await registry.fetchAll(input))[0];
  registry.recordResult({
    ...providerResult("cache-health-provider", false),
    attempt_count: 1,
    latency_ms: 77,
    cache_hit: false,
    skipped_by_circuit_breaker: false
  });
  const second = (await registry.fetchAll(input))[0];
  const health = registry.health().find((source) => source.source_id === "cache-health-provider");

  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(provider.callCount, 1);
  assert.equal(health?.health_status, "failing");
  assert.equal(health?.failure_count, 1);
  assert.equal(health?.consecutive_failure_count, 1);
  assert.equal(health?.last_attempt_count, 1);
  assert.equal(health?.last_latency_ms, 77);
  assert.equal(health?.cache_hit_count, 1);
  assert.ok(health?.last_success_at);
  assert.ok(health?.last_failed_at);
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

test("SourceRegistry redacts sensitive provider result strings before caching or exposing them", async () => {
  const provider = new SensitiveProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0 });
  const input = { fund_code: "007951", required_data: ["macro_data"], demo_mode: false };

  const first = (await registry.fetchAll(input))[0];
  const second = (await registry.fetchAll(input))[0];
  const serialized = JSON.stringify([first, second]);

  assert.equal(first.success, true);
  assert.equal(second.cache_hit, true);
  assert.doesNotMatch(serialized, /raw-secret|macro-secret|report-ref-secret|detail-secret|pdf-secret|warning-secret|error-secret/u);
  assert.doesNotMatch(serialized, /must buy|guaranteed|risk[-\s]?free|保证收益|必须买入/iu);
  assert.match(first.raw_reference ?? "", /api_key=\[REDACTED\]/u);
  assert.match(first.data?.macro_indicators?.[0]?.source_url ?? "", /credential=\[REDACTED\]/u);
  assert.match(first.data?.fund_report_refs?.[0] ?? "", /access_token=\[REDACTED\]/u);
  assert.match(first.data?.fund_report_documents?.[0]?.detail_url ?? "", /token=\[REDACTED\]/u);
  assert.match(first.data?.fund_report_documents?.[0]?.pdf_url ?? "", /api_key=\[REDACTED\]/u);
  assert.match(first.warnings[0] ?? "", /Bearer \[REDACTED\]/u);
  assert.match(first.warnings[0] ?? "", /requires evidence review/u);
  assert.match(first.error ?? "", /password=\[REDACTED\]/u);
  assert.doesNotMatch(JSON.stringify(second), /raw-secret|macro-secret|report-ref-secret|detail-secret|pdf-secret|warning-secret|error-secret/u);
});

test("SourceRegistry does not let non-core provider payloads seed fund-core context", async () => {
  const captureProvider = new ContextCaptureProvider();
  const registry = new SourceRegistry({
    providers: [new ContextPollutingMacroProvider(), captureProvider],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const results = await registry.fetchAll({ fund_code: "007951", required_data: ["macro_data", "policy_evidence"], demo_mode: false });
  const capturedContext = captureProvider.capturedContext;

  assert.equal(results.length, 2);
  assert.ok(capturedContext);
  assert.equal(capturedContext.fund_name, undefined);
  assert.equal(capturedContext.fund_type, undefined);
  assert.equal(capturedContext.current_nav, undefined);
  assert.equal(capturedContext.daily_return, undefined);
  assert.equal(capturedContext.holdings_as_of, undefined);
  assert.equal(capturedContext.holdings_source, undefined);
  assert.deepEqual(capturedContext.nav_history, undefined);
  assert.deepEqual(capturedContext.nav_history_dates, undefined);
  assert.deepEqual(capturedContext.portfolio_holdings, []);
  assert.deepEqual(capturedContext.fund_report_refs, []);
  assert.deepEqual(capturedContext.fund_report_documents, []);
  assert.equal(capturedContext.stage_returns?.one_month, undefined);
  assert.deepEqual(capturedContext.themes, ["宏观主题"]);
  assert.deepEqual(capturedContext.policy_signals, ["宏观政策"]);
  assert.deepEqual(capturedContext.news_summaries, ["宏观新闻"]);
  assert.equal(capturedContext.social_sentiment_score, 0.2);
  assert.equal(capturedContext.macro_indicators?.[0]?.indicator_id, "TEST.MACRO.CONTEXT");
});

test("SourceRegistry keeps core provider payloads available to later context-aware providers", async () => {
  const captureProvider = new ContextCaptureProvider();
  const registry = new SourceRegistry({
    providers: [new ContextCoreProvider(), captureProvider],
    cacheTtlMs: 0,
    retryCount: 0
  });

  await registry.fetchAll({ fund_code: "007951", required_data: ["fund_meta", "current_nav", "nav_history", "policy_evidence"], demo_mode: false });
  const capturedContext = captureProvider.capturedContext;

  assert.equal(capturedContext?.fund_name, "Core Context Fund");
  assert.equal(capturedContext?.fund_type, "mixed");
  assert.equal(capturedContext?.current_nav, 1.2345);
  assert.equal(capturedContext?.daily_return, -0.12);
  assert.deepEqual(capturedContext?.nav_history, [1.2, 1.2345]);
  assert.deepEqual(capturedContext?.nav_history_dates, ["2026-05-27", "2026-05-28"]);
  assert.deepEqual(capturedContext?.portfolio_holdings, ["核心持仓"]);
  assert.deepEqual(capturedContext?.fund_report_refs, ["official report ref"]);
  assert.equal(capturedContext?.stage_returns?.one_month, 0.03);
});

test("SourceRegistry cache keys include auxiliary provider context", async () => {
  const provider = new ContextEchoProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0 });

  const baseInput = { fund_code: "007951", required_data: ["industry_news"], demo_mode: false };
  const first = (await registry.fetchAll({
    ...baseInput,
    context: {
      news_summaries: ["港股新闻背景"],
      policy_signals: ["跨境政策背景"],
      macro_indicators: [
        {
          country_code: "HK",
          country_name: "Hong Kong",
          indicator_id: "TEST.HK",
          indicator_name: "HK context",
          value: 1,
          date: "2026",
          unit: "index",
          source_url: "https://macro.example.test?api_key=aux-secret-a",
          source_name: "Aux Context"
        }
      ],
      social_sentiment_score: 0.1
    }
  }))[0];
  const second = (await registry.fetchAll({
    ...baseInput,
    context: {
      news_summaries: ["美股新闻背景"],
      policy_signals: ["海外政策背景"],
      macro_indicators: [
        {
          country_code: "US",
          country_name: "United States",
          indicator_id: "TEST.US",
          indicator_name: "US context",
          value: 2,
          date: "2026",
          unit: "index",
          source_url: "https://macro.example.test?api_key=aux-secret-b",
          source_name: "Aux Context"
        }
      ],
      social_sentiment_score: 0.8
    }
  }))[0];

  assert.equal(provider.callCount, 2);
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, false);
  assert.match(first.data?.news_summaries?.[0] ?? "", /港股新闻背景/);
  assert.match(second.data?.news_summaries?.[0] ?? "", /美股新闻背景/);
});

test("SourceRegistry redacts sensitive context strings before using cache keys", async () => {
  const provider = new ContextEchoProvider("context-cache-redaction-provider");
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 60_000, retryCount: 0 });
  const input = {
    fund_code: "007951",
    required_data: ["industry_news"],
    demo_mode: false,
    context: {
      fund_name: "Sensitive Fund must buy guaranteed returns token=fund-secret",
      fund_type: "mixed risk-free password=fund-type-secret",
      themes: ["theme api_key=theme-secret 保证收益"],
      portfolio_holdings: ["holding access_token=holding-secret 必须买入"],
      holdings_as_of: "2026-03-31 credential=holding-date-secret 无风险",
      fund_report_refs: ["report token=report-ref-secret guaranteed"],
      policy_signals: ["policy authorization: Bearer policy-secret must buy"],
      news_summaries: ["news password=news-secret risk-free"],
      macro_indicators: [
        {
          country_code: "US",
          country_name: "United States",
          indicator_id: "TEST must buy",
          indicator_name: "Sensitive macro",
          value: 1,
          date: "2026 guaranteed",
          unit: "index",
          source_url: "https://macro.example.test?credential=macro-secret&claim=risk-free",
          source_name: "Macro api_key=macro-name-secret 保证收益"
        }
      ],
      fund_report_documents: [
        {
          title: "Report must buy token=title-secret",
          announcement_id: "announcement-secret=report-id-secret guaranteed",
          published_at: "2026-04-22",
          category: null,
          document_kind: "periodic_report",
          detail_url: "https://reports.example.test/detail?token=detail-secret&note=must%20buy",
          pdf_url: "https://reports.example.test/report.pdf?api_key=pdf-secret&claim=guaranteed",
          pdf_verified: true,
          pdf_content_type: "application/pdf",
          pdf_content_length: 1024,
          pdf_sha256: "token=pdf-sha-secret risk-free",
          source_name: "Official password=source-secret 保证收益",
          source_type: "official_disclosure",
          trust_level: "A"
        }
      ]
    }
  };

  const first = (await registry.fetchAll(input))[0];
  const second = (await registry.fetchAll(input))[0];
  const health = registry.health().find((source) => source.source_id === "context-cache-redaction-provider");
  const cacheKeys = [...((registry as unknown as { resultCache: Map<string, unknown> }).resultCache.keys())].join("\n");
  const serialized = JSON.stringify([first, second]);

  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(provider.callCount, 1);
  assert.equal(health?.cache_entries, 1);
  assert.match(cacheKeys, /\[REDACTED\]/u);
  assert.doesNotMatch(
    `${cacheKeys}\n${serialized}`,
    /fund-secret|fund-type-secret|theme-secret|holding-secret|holding-date-secret|report-ref-secret|policy-secret|news-secret|macro-secret|macro-name-secret|title-secret|report-id-secret|detail-secret|pdf-secret|pdf-sha-secret|source-secret/u
  );
  assert.doesNotMatch(`${cacheKeys}\n${serialized}`, /must buy|guaranteed|risk[-\s]?free|保证收益|无风险|必须买入/iu);
  assert.match(cacheKeys, /must review/u);
  assert.match(cacheKeys, /requires evidence review/u);
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

test("SourceRegistry sanitizes synthesized circuit-breaker results", async () => {
  const provider = new PollutedFailProvider();
  const registry = new SourceRegistry({ providers: [provider], cacheTtlMs: 0, retryCount: 0, failureThreshold: 1, failureCooldownMs: 60_000 });
  const input = { fund_code: "007951", required_data: ["fund_meta"], demo_mode: false };

  const first = (await registry.fetchAll(input))[0];
  const second = (await registry.fetchAll(input))[0];
  const serialized = JSON.stringify([first, second]);

  assert.equal(first.skipped_by_circuit_breaker, false);
  assert.equal(second.skipped_by_circuit_breaker, true);
  assert.doesNotMatch(serialized, /must buy|guaranteed|risk[-\s]?free|保证收益|必须买入|polluted-secret|polluted-error-secret/iu);
  assert.match(serialized, /token=\[REDACTED\]/u);
  assert.match(serialized, /password=\[REDACTED\]/u);
});

test("DataSourceService returns gap and manual import plan", async () => {
  const service = new DataSourceService();
  const coverage = service.coverage();
  const gap = await service.gaps("007951");
  const manualPlan = service.manualImportPlan();

  assert.match(coverage.field_notes.manual_workaround_source_ids, /do not satisfy official\/strong-conclusion coverage/u);
  assert.match(coverage.field_notes.coordinator_source_ids, /must not be counted as external source coverage/u);
  assert.ok(coverage.coverage.some((item) => item.requirement === "official_fund_reports" && item.manual_workaround_source_ids.includes("manual-official-report-import")));
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
  assert.deepEqual(manualPlan.required_portfolio_audit_fields, [
    "file_path",
    "file_sha256",
    "file_size_bytes",
    "file_mtime",
    "imported_at",
    "generated_at",
    "holding_count"
  ]);
  assert.ok(manualPlan.portfolio_json_validation_rules.some((rule) => rule.includes("FUNDSENTINEL_PORTFOLIO_FILE") && rule.includes("单个本地 JSON")));
  assert.ok(manualPlan.portfolio_json_validation_rules.some((rule) => rule.includes("manual_import_audit")));
  assert.ok(manualPlan.portfolio_json_validation_rules.some((rule) => rule.includes("不代表外部账户连接")));
  assert.deepEqual(manualPlan.required_csv_audit_fields, [
    "file_path",
    "file_sha256",
    "file_size_bytes",
    "file_mtime",
    "row_count",
    "date_start",
    "date_end",
    "latest_date",
    "imported_at"
  ]);
  assert.ok(manualPlan.required_report_manifest_fields.includes("pdf_sha256"));
  assert.deepEqual(manualPlan.required_report_audit_fields, [
    "manifest_path",
    "manifest_sha256",
    "manifest_size_bytes",
    "manifest_mtime",
    "report_count",
    "verified_pdf_count",
    "latest_report_date",
    "imported_at",
    "reports[].announcement_id",
    "reports[].source_url",
    "reports[].pdf_path",
    "reports[].pdf_sha256",
    "reports[].pdf_size_bytes"
  ]);
  assert.ok(manualPlan.report_manifest_validation_rules.some((rule) => rule.includes("相对于 FUNDSENTINEL_MANUAL_REPORT_DIR")));
  assert.ok(manualPlan.report_manifest_validation_rules.some((rule) => rule.includes("符号链接逃逸")));
  assert.ok(manualPlan.report_manifest_validation_rules.some((rule) => rule.includes("announcement_id") && rule.includes("冲突")));
  assert.equal(manualPlan.report_manifest_filename, "{fund_code}.reports.json");
  assert.ok(manualPlan.solutions.some((solution) => solution.proposed_actions.some((action) => action.includes("FUNDSENTINEL_PORTFOLIO_FILE"))));
  assert.ok(manualPlan.solutions.some((solution) => solution.proposed_actions.some((action) => action.includes("FUNDSENTINEL_MANUAL_REPORT_DIR"))));
  assert.ok(manualPlan.warnings.some((warning) => warning.includes("官方报告 PDF manifest 不得标记为自动抓取")));
});

test("DataSourceService sanitizes provider text across public source endpoints", async () => {
  const registry = new SourceRegistry({ providers: [new PublicTextPollutedProvider()], cacheTtlMs: 0, retryCount: 0 });
  const service = new DataSourceService(registry);

  const directSources = registry.listSources();
  const directHealth = registry.health();
  const directCandidates = registry.providerCandidates();
  const sources = service.listSources();
  const health = service.health();
  const coverage = service.coverage();
  const gap = await service.gaps("007951");
  const candidateNames = gap.acquisition_solutions.length
    ? (await new ArgusAgent(registry).prepareDataPack("candidate-sanitize", "007951")).dataPack.data_acquisition_plan.provider_candidates.map(
        (candidate) => candidate.source_name
      )
    : registry.providerCandidates().map((candidate) => candidate.source_name);
  const payload = JSON.stringify({ directSources, directHealth, directCandidates, sources, health, coverage, gap, candidateNames });

  assert.doesNotMatch(payload, /must buy|guaranteed|risk[-\s]?free|保证收益|无风险|必须买入|list-secret|raw-secret|warning-secret|gap-secret/iu);
  assert.match(payload, /must review/u);
  assert.match(payload, /requires evidence review/u);
  assert.match(payload, /api_key=\[REDACTED\]/u);
  assert.match(payload, /access_token=\[REDACTED\]/u);
  assert.match(payload, /token=\[REDACTED\]/u);
  assert.match(payload, /password=\[REDACTED\]/u);
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

class PartiallyFailingFundAnalysisService extends FundAnalysisService {
  private readonly fallbackService = new FundAnalysisService(new SourceRegistry({ demoMode: true, enableLiveProviders: false }));

  constructor(private readonly failingFundCodes: Set<string>) {
    super(new SourceRegistry({ enableLiveProviders: false }));
  }

  override async analyzeFund(fundCode: string, taskId?: string): Promise<FundAnalysisResponse> {
    if (this.failingFundCodes.has(fundCode)) {
      throw new Error(`${fundCode} provider failed must buy guaranteed risk-free 保证收益 无风险 token=home-failure-secret`);
    }
    return this.fallbackService.analyzeFund(fundCode, taskId);
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
        fund_name: "真实机会测试基金 must buy 保证收益 token=opportunity-secret",
        fund_type: "mixed",
        current_nav: 1.08,
        daily_return: 0.42,
        nav_history: [1.4, 1.28, 1.16, 1.08, 1.02, 1, 1.01, 1.03, 1.05, 1.08],
        nav_history_dates: ["2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22", "2026-05-27", "2026-05-28"],
        portfolio_holdings: ["新能源设备(300001)", "电力运营(600001)", "储能系统(300002)"],
        holdings_as_of: "2026-03-31",
        holdings_source: "official fixture",
        themes: ["新能源", "risk-free guaranteed returns"],
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

class PollutedFailProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;

  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("polluted-fail-provider"),
      source_name: "Must Buy Provider token=polluted-secret 保证收益",
      freshness_policy: "risk-free guaranteed failure cooldown"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    return {
      source_id: "polluted-fail-provider",
      source_name: "Must Buy Provider token=polluted-secret 保证收益",
      source_type: "fund_meta",
      trust_level: "B",
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: "test://polluted?token=polluted-secret",
      fetched_at: "2026-05-30T00:00:00.000Z",
      freshness: "unknown",
      warnings: ["must buy guaranteed returns risk-free 保证收益"],
      error: "upstream 必须买入 password=polluted-error-secret",
      is_demo: false
    };
  }
}

class ContextPollutingMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("context-polluting-macro-provider"),
      source_name: "Context Polluting Macro Provider",
      source_type: "macro_data",
      trust_level: "A",
      priority: 1
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "context-polluting-macro-provider",
      source_name: "Context Polluting Macro Provider",
      source_type: "macro_data",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "Non-core Fund Name",
        fund_type: "macro-only",
        current_nav: 9.9999,
        daily_return: 9.99,
        nav_history: [9.8, 9.9999],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        stage_returns: { one_month: 9.99 },
        portfolio_holdings: ["污染持仓"],
        holdings_as_of: "2026-03-31",
        holdings_source: "macro payload",
        fund_report_refs: ["polluted report ref"],
        fund_report_documents: [
          {
            title: "Polluted Report",
            announcement_id: "polluted-report",
            published_at: "2026-04-22",
            category: null,
            document_kind: "periodic_report",
            detail_url: "https://macro.example.test/detail",
            pdf_url: "https://macro.example.test/report.pdf",
            pdf_verified: true,
            pdf_content_type: "application/pdf",
            pdf_content_length: 1024,
            source_name: "Context Polluting Macro Provider",
            source_type: "official_disclosure",
            trust_level: "A"
          }
        ],
        themes: ["宏观主题"],
        policy_signals: ["宏观政策"],
        news_summaries: ["宏观新闻"],
        social_sentiment_score: 0.2,
        macro_indicators: [
          {
            country_code: "CN",
            country_name: "China",
            indicator_id: "TEST.MACRO.CONTEXT",
            indicator_name: "Macro context test",
            value: 1,
            date: "2026",
            unit: "index",
            source_url: "https://macro.example.test",
            source_name: "Context Polluting Macro Provider",
            fetched_at: "2026-05-28T00:00:00.000Z"
          }
        ]
      },
      raw_reference: "https://macro.example.test",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class ContextCoreProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("context-core-provider"),
      source_name: "Context Core Provider",
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
      source_id: "context-core-provider",
      source_name: "Context Core Provider",
      source_type: "fund_company",
      trust_level: "A",
      data_status: "ready",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "Core Context Fund",
        fund_type: "mixed",
        current_nav: 1.2345,
        daily_return: -0.12,
        nav_history: [1.2, 1.2345],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        stage_returns: { one_month: 0.03 },
        portfolio_holdings: ["核心持仓"],
        holdings_as_of: "2026-03-31",
        holdings_source: "official fixture",
        fund_report_refs: ["official report ref"]
      },
      raw_reference: "https://official.example.test/context-core",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class ContextCaptureProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  capturedContext: ProviderFundPayload | undefined;

  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("context-capture-provider"),
      source_name: "Context Capture Provider",
      source_type: "policy",
      trust_level: "A",
      priority: 2
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    this.capturedContext = input.context;
    return {
      source_id: "context-capture-provider",
      source_name: "Context Capture Provider",
      source_type: "policy",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        policy_signals: ["captured context"]
      },
      raw_reference: "test://context-capture",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class ContextEchoProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  callCount = 0;
  capturedContexts: ProviderFundPayload[] = [];

  constructor(private readonly sourceId = "context-echo-provider") {}

  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo(this.sourceId),
      source_name: "Context Echo Provider",
      source_type: "news",
      trust_level: "A",
      priority: 1
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    this.callCount += 1;
    this.capturedContexts.push(JSON.parse(JSON.stringify(input.context ?? {})) as ProviderFundPayload);
    return {
      source_id: this.sourceId,
      source_name: "Context Echo Provider",
      source_type: "news",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        news_summaries: [
          [
            input.context?.news_summaries?.join("|") ?? "",
            input.context?.policy_signals?.join("|") ?? "",
            input.context?.macro_indicators?.map((indicator) => `${indicator.country_code}:${indicator.indicator_id}:${indicator.value}`).join("|") ?? "",
            String(input.context?.social_sentiment_score ?? "")
          ]
            .filter(Boolean)
            .join(" / ")
        ]
      },
      raw_reference: "test://context-echo",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class SensitiveProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("sensitive-provider"),
      source_name: "Sensitive Fixture Provider",
      source_type: "macro_data",
      trust_level: "A",
      priority: 1
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "sensitive-provider",
      source_name: "Sensitive Fixture Provider",
      source_type: "macro_data",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        macro_indicators: [
          {
            country_code: "US",
            country_name: "United States",
            indicator_id: "TEST",
            indicator_name: "Sensitive Test Indicator",
            value: 1,
            date: "2026",
            unit: "percent",
            source_url: "https://macro.example.test/series?credential=macro-secret",
            source_name: "Sensitive Fixture Provider",
            fetched_at: "2026-05-28T00:00:00.000Z"
          }
        ],
        fund_report_refs: ["report url=https://reports.example.test/report.pdf?access_token=report-ref-secret"],
        fund_report_documents: [
          {
            title: "Sensitive Report",
            announcement_id: "sensitive-report",
            published_at: "2026-04-22",
            category: null,
            document_kind: "periodic_report",
            detail_url: "https://reports.example.test/detail?token=detail-secret",
            pdf_url: "https://reports.example.test/report.pdf?api_key=pdf-secret",
            pdf_verified: true,
            pdf_content_type: "application/pdf",
            pdf_content_length: 1024,
            source_name: "Sensitive Fixture Provider",
            source_type: "official_disclosure",
            trust_level: "A"
          }
        ]
      },
      raw_reference: "https://provider.example.test/nav?api_key=raw-secret&note=must%20buy",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: ["authorization: Bearer warning-secret must buy guaranteed returns risk-free 保证收益"],
      error: "client warning password=error-secret 必须买入",
      is_demo: false
    };
  }
}

class PublicTextPollutedProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      ...sourceInfo("public-text-polluted-provider"),
      source_name: "Must Buy Provider 保证收益",
      access_method: "public endpoint https://provider.example.test?api_key=list-secret with guaranteed returns",
      freshness_policy: "risk-free same-day claim",
      notes: "必须买入且无风险的错误说明"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "public-text-polluted-provider",
      source_name: "Must Buy Provider 保证收益",
      source_type: "fund_meta",
      trust_level: "B",
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: "https://provider.example.test/data?access_token=raw-secret",
      fetched_at: "2026-05-30T00:00:00.000Z",
      freshness: "unknown",
      warnings: ["must buy, guaranteed returns, risk-free, 保证收益 token=warning-secret"],
      error: "upstream 必须买入 password=gap-secret",
      is_demo: false
    };
  }
}
