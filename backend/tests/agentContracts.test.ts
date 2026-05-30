import assert from "node:assert/strict";
import test from "node:test";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../src/agents/index.js";
import { SourceRegistry } from "../src/dataSources/index.js";
import type { DataProviderResult, FundDataSourceInput, ProviderFundPayload } from "../src/dataSources/index.js";
import type { AgentResult, DataQuality } from "../src/schemas/index.js";
import { MockDataService } from "../src/services/index.js";

test("Argus returns AgentResult with unavailable data by default", async () => {
  const argus = new ArgusAgent(new SourceRegistry({ enableLiveProviders: false }));
  const { dataPack, result: argusResult } = await argus.prepareDataPack("contract-task", "007951");

  assert.equal(argusResult.agent_name, "Argus");
  assert.equal(argusResult.task_id, "contract-task");
  assert.equal(argusResult.status, "failed");
  assert.equal(argusResult.is_mock, false);
  assert.equal(dataPack.data_status, "unavailable");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.allow_strong_conclusion, false);
});

test("specialist agents still return AgentResult with explicit demo fixture input", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const logosResult = await new LogosAgent().run("demo-contract", dataPack);
  const nadirResult = await new NadirAgent().run("demo-contract", dataPack);
  const vegaResult = await new VegaAgent().run("demo-contract", dataPack);
  const aegisResult = await new AegisAgent().run("contract-task", dataPack, {
    Logos: logosResult,
    Nadir: nadirResult,
    Vega: vegaResult
  });
  const atlasResult = await new AtlasAgent().finalReview("contract-task", dataPack, {
    Argus: { ...logosResult, agent_name: "Argus" },
    Logos: logosResult,
    Nadir: nadirResult,
    Vega: vegaResult,
    Aegis: aegisResult
  });

  for (const result of [logosResult, nadirResult, vegaResult, aegisResult, atlasResult]) {
    assert.equal(result.is_mock, true);
    assert.ok(["success", "warning", "failed"].includes(result.status));
    assert.equal(typeof result.agent_name, "string");
  }
});

test("demo mode allows demo dataPack but forbids strong conclusion", async () => {
  const { dataPack, result } = await new ArgusAgent(new SourceRegistry({ demoMode: true, enableLiveProviders: false })).prepareDataPack("argus-task", "007951");

  assert.equal(dataPack.is_mock, true);
  assert.equal(dataPack.data_status, "demo");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.equal(dataPack.data_quality.is_mock, true);
  assert.equal(result.is_mock, true);
  assert.equal(result.metrics.data_status, "demo");
  assert.ok(result.confidence <= 0.35);
  assert.equal(result.score, 35);
  assert.equal(result.metrics.action, undefined);
  assert.equal(result.metrics.buy, undefined);
  assert.equal(result.metrics.sell, undefined);
  assert.equal(result.metrics.position, undefined);
});

class UnsanitizedRegistry extends SourceRegistry {
  constructor(private readonly unsanitizedResults: Array<DataProviderResult<ProviderFundPayload>>) {
    super({ providers: [], enableLiveProviders: false, shareState: false });
  }

  override providerCandidates() {
    return [
      {
        source_id: "unsanitized-provider",
        source_name: "Must Buy Provider 保证收益",
        source_type: "fund_meta",
        priority: 1,
        is_demo: false,
        enabled: true
      }
    ];
  }

  override async fetchAll(_input: FundDataSourceInput): Promise<Array<DataProviderResult<ProviderFundPayload>>> {
    return this.unsanitizedResults;
  }
}

test("Argus sanitizes direct dataPack and AgentResult provider text", async () => {
  const registry = new UnsanitizedRegistry([
    {
      source_id: "unsanitized-provider",
      source_name: "Must Buy Provider 保证收益",
      source_type: "fund_meta",
      trust_level: "A",
      data_status: "partial",
      success: false,
      data: null,
      raw_reference: "https://provider.example.test/fund?api_key=argus-secret",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "unknown",
      warnings: ["risk-free warning with token=warning-secret and 必须买入"],
      error: "guaranteed returns error with access_token=error-secret and 无风险",
      is_demo: false
    }
  ]);

  const { dataPack, result } = await new ArgusAgent(registry).prepareDataPack("argus-sanitize-boundary", "007951");
  const payload = JSON.stringify({ dataPack, result });

  assert.equal(result.agent_name, "Argus");
  assert.equal(result.task_id, "argus-sanitize-boundary");
  assert.equal(dataPack.data_status, "unavailable");
  assert.doesNotMatch(payload, /must buy|guaranteed|risk[-\s]?free|保证收益|无风险|必须买入|argus-secret|warning-secret|error-secret/iu);
  assert.match(payload, /must review/u);
  assert.match(payload, /requires evidence review/u);
  assert.match(payload, /\[REDACTED\]/u);
});

test("Atlas uses explicit dataPack mock marker instead of status inference", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  dataPack.data_status = "partial";
  dataPack.is_mock = true;
  dataPack.data_quality.is_mock = true;
  dataPack.allow_downstream_analysis = false;
  const result = await new AtlasAgent().finalReview("explicit-mock", dataPack, {});
  const decision = new AtlasAgent().buildFinalDecision(dataPack, {});

  assert.equal(result.is_mock, true);
  assert.equal(result.evidence[0]?.is_mock, true);
  assert.equal(decision.is_mock, true);
});

test("low data quality prevents staged_buy", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const lowQuality: DataQuality = {
    level: "low",
    score: 0.2,
    source: "test",
    updated_at: new Date().toISOString(),
    warnings: ["forced low quality"],
    is_mock: true
  };
  dataPack.data_quality = lowQuality;
  const strongResult: AgentResult = {
    agent_name: "Logos",
    agent_role: "test",
    agent_version: "0.1",
    task_id: "low-quality",
    fund_code: dataPack.fund_code,
    status: "success",
    score: 95,
    confidence: 0.95,
    summary: "strong",
    evidence: [],
    metrics: {},
    warnings: [],
    next_suggestions: [],
    created_at: new Date().toISOString(),
    is_mock: true
  };

  const result = await new AegisAgent().run("low-quality", dataPack, {
    Logos: strongResult,
    Nadir: { ...strongResult, agent_name: "Nadir" },
    Vega: { ...strongResult, agent_name: "Vega" }
  });

  assert.notEqual(result.metrics.action, "staged_buy");
});

test("Aegis real-data result does not describe itself as mock research", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  dataPack.is_mock = false;
  dataPack.data_status = "ready";
  dataPack.data_quality = {
    ...dataPack.data_quality,
    is_mock: false,
    level: "high",
    score: 0.86
  };
  const baseResult: AgentResult = {
    agent_name: "Logos",
    agent_role: "test",
    agent_version: "0.1",
    task_id: "aegis-real-language",
    fund_code: dataPack.fund_code,
    status: "success",
    score: 60,
    confidence: 0.75,
    summary: "supporting review",
    evidence: [],
    metrics: {},
    warnings: [],
    next_suggestions: [],
    created_at: new Date().toISOString(),
    is_mock: false
  };

  const result = await new AegisAgent().run("aegis-real-language", dataPack, {
    Logos: baseResult,
    Nadir: { ...baseResult, agent_name: "Nadir" },
    Vega: { ...baseResult, agent_name: "Vega" }
  });
  const text = JSON.stringify({ summary: result.summary, next_suggestions: result.next_suggestions });

  assert.equal(result.is_mock, false);
  assert.doesNotMatch(text, /mock 研究建议|冲动重仓|可执行仓位策略/iu);
  assert.match(result.summary, /不是交易指令/);
});

test("specialist agents downgrade when Argus blocks strong conclusions", async () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  dataPack.is_mock = false;
  dataPack.data_status = "partial";
  dataPack.allow_downstream_analysis = true;
  dataPack.allow_strong_conclusion = false;
  dataPack.data_quality = {
    ...dataPack.data_quality,
    is_mock: false,
    level: "medium",
    score: 0.68
  };
  dataPack.policy_signals = ["2026-05-20 官方政策背景证据", "2026-05-21 官方产业政策证据"];
  dataPack.portfolio_holdings = ["国债", "政策性金融债", "信用债"];
  dataPack.themes = ["债券", "固收"];
  dataPack.news_summaries = ["官方行业新闻背景证据"];
  dataPack.nav_history = [1.08, 1.07, 1.06, 1.055, 1.052, 1.05, 1.051, 1.053, 1.056, 1.06];

  const logosResult = await new LogosAgent().run("strong-block-specialists", dataPack);
  const nadirResult = await new NadirAgent().run("strong-block-specialists", dataPack);
  const vegaResult = await new VegaAgent().run("strong-block-specialists", dataPack);
  const aegisResult = await new AegisAgent().run("strong-block-specialists", dataPack, {
    Logos: logosResult,
    Nadir: nadirResult,
    Vega: vegaResult
  });

  for (const result of [logosResult, nadirResult, vegaResult, aegisResult]) {
    assert.equal(result.status, "warning");
    assert.ok(result.confidence <= 0.55);
    assert.ok(result.warnings.some((warning) => warning.includes("Argus 未允许强结论")));
  }
  assert.equal(aegisResult.metrics.action, "observe");
});

test("critical failed agent prevents aggressive Atlas decision", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  const good: AgentResult = {
    agent_name: "Logos",
    agent_role: "test",
    agent_version: "0.1",
    task_id: "failed-agent",
    fund_code: dataPack.fund_code,
    status: "success",
    score: 90,
    confidence: 0.9,
    summary: "good",
    evidence: [],
    metrics: {},
    warnings: [],
    next_suggestions: [],
    created_at: new Date().toISOString(),
    is_mock: true
  };
  const decision = new AtlasAgent().buildFinalDecision(dataPack, {
    Argus: { ...good, agent_name: "Argus" },
    Logos: good,
    Nadir: { ...good, agent_name: "Nadir" },
    Vega: { ...good, agent_name: "Vega", status: "failed" },
    Aegis: { ...good, agent_name: "Aegis", score: 88, metrics: { action: "staged_buy", overall_score: 88 } }
  });

  assert.ok(!["trial_buy", "staged_buy"].includes(decision.action));
});

test("Atlas downgrades aggressive action when Argus blocks strong conclusions", () => {
  const dataPack = new MockDataService().getFundDataPack("007951");
  dataPack.is_mock = false;
  dataPack.data_status = "partial";
  dataPack.allow_downstream_analysis = true;
  dataPack.allow_strong_conclusion = false;
  dataPack.data_quality = {
    ...dataPack.data_quality,
    is_mock: false,
    level: "medium",
    score: 0.68
  };
  dataPack.data_quality_report = {
    ...dataPack.data_quality_report,
    data_status: "partial",
    allow_downstream_analysis: true,
    allow_strong_conclusion: false,
    missing_core_fields: [],
    missing_auxiliary_fields: ["official_fund_reports"]
  };
  const good: AgentResult = {
    agent_name: "Logos",
    agent_role: "test",
    agent_version: "0.1",
    task_id: "strong-block",
    fund_code: dataPack.fund_code,
    status: "success",
    score: 90,
    confidence: 0.9,
    summary: "strong",
    evidence: [],
    metrics: {},
    warnings: [],
    next_suggestions: [],
    created_at: new Date().toISOString(),
    is_mock: false
  };
  const decision = new AtlasAgent().buildFinalDecision(dataPack, {
    Argus: { ...good, agent_name: "Argus" },
    Logos: good,
    Nadir: { ...good, agent_name: "Nadir" },
    Vega: { ...good, agent_name: "Vega" },
    Aegis: { ...good, agent_name: "Aegis", score: 88, metrics: { action: "staged_buy", overall_score: 88 } }
  });

  assert.equal(decision.action, "observe");
  assert.equal(decision.risk_level, "medium");
  assert.ok(decision.risk_warnings.some((warning) => warning.includes("Argus 未允许强结论")));
  assert.doesNotMatch(JSON.stringify(decision), /买入|卖出|仓位/u);
});
