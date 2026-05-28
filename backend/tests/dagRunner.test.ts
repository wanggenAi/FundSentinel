import assert from "node:assert/strict";
import test from "node:test";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../src/agents/index.js";
import { FundAnalysisDagRunner, SharedBlackboard } from "../src/orchestration/index.js";
import { MockDataService } from "../src/services/index.js";

test("DAG runner executes dependency order and parallel group", async () => {
  const trace: Array<[string, string]> = [];
  const blackboard = new SharedBlackboard();
  const runner = new FundAnalysisDagRunner({
    argus: new ArgusAgent(new MockDataService()),
    logos: new LogosAgent(),
    nadir: new NadirAgent(),
    vega: new VegaAgent(),
    aegis: new AegisAgent(),
    atlas: new AtlasAgent(),
    blackboard,
    traceRecorder: (agent, event) => trace.push([agent, event])
  });

  const { dataPack, agentResults } = await runner.run("dag-task", "007951");

  assert.equal(dataPack.fund_code, "007951");
  assert.deepEqual(new Set(Object.keys(agentResults)), new Set(["Argus", "Logos", "Nadir", "Vega", "Aegis", "Atlas"]));
  assert.ok(indexOf(trace, ["Argus", "finish"]) < indexOf(trace, ["Logos,Nadir,Vega", "parallel_start"]));
  assert.ok(indexOf(trace, ["Logos,Nadir,Vega", "parallel_finish"]) < indexOf(trace, ["Aegis", "start"]));
  assert.ok(indexOf(trace, ["Aegis", "finish"]) < indexOf(trace, ["Atlas", "start"]));
  assert.ok(trace.some(([agent, event]) => agent === "Logos" && event === "start"));
  assert.ok(trace.some(([agent, event]) => agent === "Nadir" && event === "start"));
  assert.ok(trace.some(([agent, event]) => agent === "Vega" && event === "start"));
});

function indexOf(trace: Array<[string, string]>, item: [string, string]): number {
  return trace.findIndex(([agent, event]) => agent === item[0] && event === item[1]);
}

