import type { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import type { AgentResult, FundDataPack } from "../schemas/index.js";
import { SharedBlackboard } from "./blackboard.js";

export type TraceRecorder = (agentName: string, event: string) => void;

export class FundAnalysisDagRunner {
  constructor(
    private readonly deps: {
      argus: ArgusAgent;
      logos: LogosAgent;
      nadir: NadirAgent;
      vega: VegaAgent;
      aegis: AegisAgent;
      atlas: AtlasAgent;
      blackboard: SharedBlackboard;
      traceRecorder?: TraceRecorder;
    }
  ) {}

  async run(taskId: string, fundCode: string): Promise<{ dataPack: FundDataPack; agentResults: Record<string, AgentResult> }> {
    const { blackboard } = this.deps;
    blackboard.createTask(taskId, fundCode);

    this.trace("Argus", "start");
    const { dataPack, result: argusResult } = await this.deps.argus.prepareDataPack(taskId, fundCode);
    blackboard.writeArgusDataPack(taskId, dataPack);
    blackboard.writeAgentResult(taskId, argusResult);
    this.trace("Argus", "finish");

    this.trace("Logos,Nadir,Vega", "parallel_start");
    const [logosResult, nadirResult, vegaResult] = await Promise.all([
      this.runAgent("Logos", this.deps.logos.run(taskId, dataPack)),
      this.runAgent("Nadir", this.deps.nadir.run(taskId, dataPack)),
      this.runAgent("Vega", this.deps.vega.run(taskId, dataPack))
    ]);
    for (const result of [logosResult, nadirResult, vegaResult]) {
      blackboard.writeAgentResult(taskId, result);
    }
    this.trace("Logos,Nadir,Vega", "parallel_finish");

    if (!blackboard.dependenciesCompleted(taskId, ["Logos", "Nadir", "Vega"])) {
      blackboard.markDegraded(taskId, "Aegis dependencies incomplete.");
    }

    this.trace("Aegis", "start");
    const aegisResult = await this.deps.aegis.run(taskId, dataPack, {
      Logos: logosResult,
      Nadir: nadirResult,
      Vega: vegaResult
    });
    blackboard.writeAgentResult(taskId, aegisResult);
    this.trace("Aegis", "finish");

    this.trace("Atlas", "start");
    const atlasResult = await this.deps.atlas.finalReview(taskId, dataPack, blackboard.getAllAgentResults(taskId));
    blackboard.writeAgentResult(taskId, atlasResult);
    blackboard.markCompleted(taskId);
    this.trace("Atlas", "finish");

    return { dataPack, agentResults: blackboard.getAllAgentResults(taskId) };
  }

  private async runAgent(name: string, promise: Promise<AgentResult>): Promise<AgentResult> {
    this.trace(name, "start");
    const result = await promise;
    this.trace(name, "finish");
    return result;
  }

  private trace(agentName: string, event: string): void {
    this.deps.traceRecorder?.(agentName, event);
  }
}

