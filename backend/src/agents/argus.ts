import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FundDataPack } from "../schemas/index.js";
import { type AgentStatus } from "../schemas/index.js";
import { AIGateway } from "../services/aiGateway.js";
import { MockDataService } from "../services/mockDataService.js";

export class ArgusAgent extends BaseAgent {
  readonly name = "Argus";
  readonly role = "Data Steward Agent";
  readonly responsibilities = [
    "管理基金基础数据、历史净值、持仓数据和 mock 数据质量",
    "输出 FundDataPack 并显式标记 mock",
    "记录数据更新时间、可信度和质量告警"
  ];

  constructor(
    private readonly mockDataService = new MockDataService(),
    aiGateway?: AIGateway
  ) {
    super(aiGateway);
  }

  async prepareDataPack(taskId: string, fundCode: string): Promise<{ dataPack: FundDataPack; result: AgentResult }> {
    const dataPack = this.mockDataService.getFundDataPack(fundCode);
    const status: AgentStatus = dataPack.data_quality.level === "low" ? "warning" : "success";
    const evidence: EvidenceItem[] = [
      {
        title: "Mock 基金数据包",
        source_name: "MockDataService",
        source_type: "mock",
        trust_level: "C",
        summary: "V0.1 使用内置 mock 基金基础信息、净值历史、主题和质量标记。",
        importance_score: 0.8,
        related_theme: null,
        published_at: dataPack.updated_at,
        url: null,
        is_mock: true
      }
    ];

    return {
      dataPack,
      result: this.buildResult({
        taskId,
        fundCode: dataPack.fund_code,
        status,
        score: Number((dataPack.data_quality.score * 100).toFixed(2)),
        confidence: dataPack.data_quality.score,
        summary: `${dataPack.fund_name} 数据包已生成，质量等级 ${dataPack.data_quality.level}。`,
        evidence,
        metrics: {
          data_quality_score: dataPack.data_quality.score,
          nav_points: dataPack.nav_history.length,
          theme_count: dataPack.themes.length,
          is_mock: true
        },
        warnings: dataPack.data_quality.warnings,
        nextSuggestions: ["接入真实基金基础信息、净值、基金报告和持仓披露数据源。"]
      })
    };
  }

  async run(taskId: string, fundCode: string): Promise<AgentResult> {
    return (await this.prepareDataPack(taskId, fundCode)).result;
  }
}

