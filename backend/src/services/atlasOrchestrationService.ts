import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import { SourceRegistry } from "../dataSources/index.js";
import type { AgentInfo } from "../schemas/index.js";
import { sanitizePublicStructure } from "../utils/publicText.js";
import { AIGateway } from "./aiGateway.js";

export class AtlasOrchestrationService {
  constructor(
    private readonly sourceRegistry = new SourceRegistry(),
    private readonly aiGateway = new AIGateway()
  ) {}

  listAgents(): AgentInfo[] {
    return [
      new AtlasAgent(this.aiGateway).info(),
      new ArgusAgent(this.sourceRegistry, this.aiGateway).info(),
      new LogosAgent(this.aiGateway).info(),
      new NadirAgent(this.aiGateway).info(),
      new VegaAgent(this.aiGateway).info(),
      new AegisAgent(this.aiGateway).info()
    ];
  }

  listPublicAgents(): AgentInfo[] {
    return sanitizePublicStructure(this.listAgents().map((agent) => this.publicAgentInfo(agent)));
  }

  private publicAgentInfo(agent: AgentInfo): AgentInfo {
    if (agent.name === "Nadir") {
      return {
        ...agent,
        role: "Valuation Review Agent",
        responsibilities: [
          "判断基金是否处于历史相对低位",
          "计算历史分位、最大回撤、距离高点和低点",
          "为机会发现和风险复核提供净值区间评分"
        ]
      };
    }

    if (agent.name === "Aegis") {
      return {
        ...agent,
        role: "Risk Review Agent",
        responsibilities: [
          "汇总专业 Agent 的冲突、风险和证据质量",
          "输出 observe、risk_review、evidence_review、data_gap_review 等复核状态",
          "在数据质量低、模块冲突或关键 Agent 失败时降级为人工复核"
        ]
      };
    }

    return agent;
  }
}
