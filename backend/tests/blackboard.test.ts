import assert from "node:assert/strict";
import test from "node:test";
import { SharedBlackboard } from "../src/orchestration/index.js";
import type { AgentResult } from "../src/schemas/index.js";
import { MockDataService } from "../src/services/index.js";

test("blackboard writes, reads, checks dependencies, and exports snapshot", () => {
  const blackboard = new SharedBlackboard();
  blackboard.createTask("task-1", "007951");
  const dataPack = new MockDataService().getFundDataPack("007951");
  const result: AgentResult = {
    agent_name: "Argus",
    agent_role: "Data Steward Agent",
    agent_version: "0.1",
    task_id: "task-1",
    fund_code: "007951",
    status: "success",
    score: 88,
    confidence: 0.88,
    summary: "ok",
    evidence: [],
    metrics: {},
    warnings: [],
    next_suggestions: [],
    created_at: new Date().toISOString(),
    is_mock: true
  };

  blackboard.writeArgusDataPack("task-1", dataPack);
  blackboard.writeAgentResult("task-1", result);

  assert.equal(blackboard.getDataPack("task-1")?.fund_code, "007951");
  assert.equal(blackboard.getAgentResult("task-1", "Argus")?.agent_name, "Argus");
  assert.equal(blackboard.dependenciesCompleted("task-1", ["Argus"]), true);
  const snapshot = blackboard.exportSnapshot("task-1") as { data_pack: { is_mock: boolean }; agent_results: Record<string, { is_mock: boolean }> };
  assert.equal(snapshot.data_pack.is_mock, true);
  assert.equal(snapshot.agent_results.Argus.is_mock, true);
});

test("blackboard can mark degraded and failed", () => {
  const blackboard = new SharedBlackboard();
  blackboard.createTask("task-2", "007951");
  blackboard.markDegraded("task-2", "test degrade");
  blackboard.markFailed("task-2", "test failure");

  const snapshot = blackboard.exportSnapshot("task-2");
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.failed, true);
  assert.equal(snapshot.failure_reason, "test failure");
});

