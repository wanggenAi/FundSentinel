import assert from "node:assert/strict";
import test from "node:test";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../src/agents/index.js";
import { SourceRegistry } from "../src/dataSources/index.js";
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
