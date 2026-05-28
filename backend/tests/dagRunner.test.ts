import assert from "node:assert/strict";
import test from "node:test";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../src/agents/index.js";
import { SourceRegistry } from "../src/dataSources/index.js";
import { FundAnalysisDagRunner, SharedBlackboard } from "../src/orchestration/index.js";

test("DAG runner stops downstream agents when real data is unavailable", async () => {
  const trace: Array<[string, string]> = [];
  const blackboard = new SharedBlackboard();
  const runner = new FundAnalysisDagRunner({
    argus: new ArgusAgent(new SourceRegistry({ enableLiveProviders: false })),
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
  assert.equal(dataPack.data_status, "unavailable");
  assert.deepEqual(new Set(Object.keys(agentResults)), new Set(["Argus", "Atlas"]));
  assert.equal(trace.some(([agent]) => agent === "Logos"), false);
  assert.equal(trace.some(([agent]) => agent === "Nadir"), false);
  assert.equal(trace.some(([agent]) => agent === "Vega"), false);
  assert.equal(trace.some(([agent]) => agent === "Aegis"), false);
});

test("DAG runner executes dependency order and parallel group in demo mode", async () => {
  const trace: Array<[string, string]> = [];
  const blackboard = new SharedBlackboard();
  const runner = new FundAnalysisDagRunner({
    argus: new ArgusAgent(new SourceRegistry(true)),
    logos: new LogosAgent(),
    nadir: new NadirAgent(),
    vega: new VegaAgent(),
    aegis: new AegisAgent(),
    atlas: new AtlasAgent(),
    blackboard,
    traceRecorder: (agent, event) => trace.push([agent, event])
  });

  const { dataPack, agentResults } = await runner.run("demo-dag-task", "007951");

  assert.equal(dataPack.data_status, "demo");
  assert.deepEqual(new Set(Object.keys(agentResults)), new Set(["Argus", "Logos", "Nadir", "Vega", "Aegis", "Atlas"]));
  assert.ok(indexOf(trace, ["Argus", "finish"]) < indexOf(trace, ["Logos,Nadir,Vega", "parallel_start"]));
  assert.ok(indexOf(trace, ["Logos,Nadir,Vega", "parallel_finish"]) < indexOf(trace, ["Aegis", "start"]));
});

function indexOf(trace: Array<[string, string]>, item: [string, string]): number {
  return trace.findIndex(([agent, event]) => agent === item[0] && event === item[1]);
}
