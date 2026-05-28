import assert from "node:assert/strict";
import test from "node:test";
import { FundAnalysisService, HomeService, OpportunityService } from "../src/services/index.js";

test("Atlas generates FundAnalysisResponse", async () => {
  const response = await new FundAnalysisService().analyzeFund("007951", "analysis-flow");

  assert.equal(response.is_mock, true);
  assert.equal(response.final_decision.generated_by, "Atlas");
  assert.deepEqual(new Set(Object.keys(response.agent_results)), new Set(["Argus", "Logos", "Nadir", "Vega", "Aegis", "Atlas"]));
  assert.equal((response.blackboard_snapshot as { status: string }).status, "completed");
  assert.equal(response.data_pack.is_mock, true);
});

test("home service returns dashboard with related agents", async () => {
  const response = await new HomeService().getHomeDashboard();

  assert.equal(response.is_mock, true);
  assert.ok(response.holding_count > 0);
  assert.ok(response.strategy_triggers.length > 0);
  assert.ok(response.strategy_triggers.every((trigger) => trigger.related_agent));
  assert.ok(response.strategy_triggers.every((trigger) => trigger.is_mock));
});

test("opportunity service returns candidates with scores and actions", async () => {
  const response = await new OpportunityService().getOpportunities(5);

  assert.equal(response.is_mock, true);
  assert.equal(response.candidates.length, 5);
  assert.ok(response.candidates.every((candidate) => typeof candidate.overall_opportunity_score === "number"));
  assert.ok(response.candidates.every((candidate) => candidate.action));
  assert.ok(response.candidates.every((candidate) => candidate.is_mock));
});

