import assert from "node:assert/strict";
import test from "node:test";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../src/agents/index.js";
import type { AgentResult, DataQuality } from "../src/schemas/index.js";
import { MockDataService } from "../src/services/index.js";

test("each agent returns AgentResult", async () => {
  const mockData = new MockDataService();
  const argus = new ArgusAgent(mockData);
  const { dataPack, result: argusResult } = await argus.prepareDataPack("contract-task", "007951");
  const logosResult = await new LogosAgent().run("contract-task", dataPack);
  const nadirResult = await new NadirAgent().run("contract-task", dataPack);
  const vegaResult = await new VegaAgent().run("contract-task", dataPack);
  const aegisResult = await new AegisAgent().run("contract-task", dataPack, {
    Logos: logosResult,
    Nadir: nadirResult,
    Vega: vegaResult
  });
  const atlasResult = await new AtlasAgent().finalReview("contract-task", dataPack, {
    Argus: argusResult,
    Logos: logosResult,
    Nadir: nadirResult,
    Vega: vegaResult,
    Aegis: aegisResult
  });

  for (const result of [argusResult, logosResult, nadirResult, vegaResult, aegisResult, atlasResult]) {
    assert.equal(result.task_id, "contract-task");
    assert.equal(result.is_mock, true);
    assert.ok(["success", "warning", "failed"].includes(result.status));
    assert.equal(typeof result.agent_name, "string");
  }
});

test("Argus output is explicitly mock", async () => {
  const { dataPack, result } = await new ArgusAgent(new MockDataService()).prepareDataPack("argus-task", "007951");

  assert.equal(dataPack.is_mock, true);
  assert.equal(dataPack.data_quality.is_mock, true);
  assert.equal(result.is_mock, true);
  assert.equal(result.metrics.is_mock, true);
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

