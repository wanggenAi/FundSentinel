import { randomUUID } from "node:crypto";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import { SharedBlackboard, FundAnalysisDagRunner } from "../orchestration/index.js";
import type { FundAnalysisResponse } from "../schemas/index.js";
import { AIGateway } from "./aiGateway.js";
import { MockDataService } from "./mockDataService.js";

export class FundAnalysisService {
  constructor(
    private readonly mockDataService = new MockDataService(),
    private readonly aiGateway = new AIGateway()
  ) {}

  async analyzeFund(fundCode: string, taskId = `fund-analysis-${randomUUID().slice(0, 12)}`): Promise<FundAnalysisResponse> {
    const blackboard = new SharedBlackboard();
    const atlas = new AtlasAgent(this.aiGateway);
    const runner = new FundAnalysisDagRunner({
      argus: new ArgusAgent(this.mockDataService, this.aiGateway),
      logos: new LogosAgent(this.aiGateway),
      nadir: new NadirAgent(this.aiGateway),
      vega: new VegaAgent(this.aiGateway),
      aegis: new AegisAgent(this.aiGateway),
      atlas,
      blackboard
    });
    const { dataPack, agentResults } = await runner.run(taskId, fundCode);
    const finalDecision = atlas.buildFinalDecision(dataPack, agentResults);
    return {
      task_id: taskId,
      fund_code: dataPack.fund_code,
      fund_name: dataPack.fund_name,
      is_mock: true,
      data_pack: dataPack,
      agent_results: agentResults,
      final_decision: finalDecision,
      blackboard_snapshot: blackboard.exportSnapshot(taskId),
      generated_at: finalDecision.generated_at
    };
  }
}

