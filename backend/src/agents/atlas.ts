import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FinalDecision, FundDataPack, RiskLevel, StrategyAction } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";

export class AtlasAgent extends BaseAgent {
  readonly name = "Atlas";
  readonly role = "Chief Orchestrator Agent";
  readonly responsibilities = [
    "理解系统业务目标并调度专业 Agent",
    "处理 Agent 结论冲突、降级和结构化汇总",
    "服务首页、采基广场和基金详情，不作为当前前端主角"
  ];

  async finalReview(taskId: string, dataPack: FundDataPack, agentResults: Record<string, AgentResult>): Promise<AgentResult> {
    const aiResponse = await this.askAI({
      taskId,
      fundCode: dataPack.fund_code,
      prompt: "Perform final orchestration review. Respect professional agent outputs and downgrade aggressive suggestions when uncertain.",
      context: { fund: dataPack, agent_results: agentResults }
    });
    const decision = this.buildFinalDecision(dataPack, agentResults);
    const failedAgents = Object.entries(agentResults)
      .filter(([, result]) => result.status === "failed")
      .map(([name]) => name);
    const warnings: string[] = [];
    if (failedAgents.length) warnings.push(`关键 Agent failed: ${failedAgents.join(", ")}，Atlas 已降级最终建议。`);
    if (aiResponse.available && aiResponse.content) warnings.push("已调用统一 AI API 辅助审阅；最终输出仍遵守降级规则和结构化合约。");
    warnings.push(...decision.risk_warnings);

    const evidence: EvidenceItem[] = [
      {
        title: "Atlas 最终审阅",
        source_name: "Atlas V0.1 orchestration",
        source_type: dataPack.data_status === "demo" ? "demo" : "official",
        trust_level: "C",
        summary: dataPack.allow_downstream_analysis
          ? "基于 Argus、Logos、Nadir、Vega、Aegis 的结构化结果做保守汇总。"
          : "Argus 判断真实数据不足，Atlas 停止后续策略分析。",
        importance_score: 0.9,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      }
    ];

    return this.buildResult({
      taskId,
      fundCode: dataPack.fund_code,
      status: failedAgents.length || ["avoid", "observe"].includes(decision.action) ? "warning" : "success",
      score: decision.metrics.overall_score,
      confidence: decision.confidence,
      summary: decision.summary,
      evidence,
      metrics: {
        action: decision.action,
        risk_level: decision.risk_level,
        ai_gateway_available: aiResponse.available,
        ai_model: aiResponse.model,
        ...decision.metrics
      },
      warnings,
      nextSuggestions: decision.invalidation_conditions
    });
  }

  buildFinalDecision(dataPack: FundDataPack, agentResults: Record<string, AgentResult>): FinalDecision {
    if (!dataPack.allow_downstream_analysis || ["unavailable", "insufficient"].includes(dataPack.data_status)) {
      return {
        action: "avoid",
        confidence: Math.min(agentResults.Argus?.confidence ?? 0.1, 0.2),
        risk_level: "high",
        summary: `Atlas 审阅：${dataPack.fund_code} 真实数据 ${dataPack.data_status}，停止策略分析，仅返回数据缺口报告。`,
        reasons: [agentResults.Argus?.summary ?? "Argus 未能提供可用真实数据。"],
        risk_warnings: [
          "真实核心数据不足，禁止输出买入、卖出或仓位结论。",
          "本系统不提供收益保证，也不执行真实交易。"
        ],
        invalidation_conditions: dataPack.acquisition_solutions.flatMap((solution) => solution.proposed_actions),
        source_agents: ["Argus", "Atlas"],
        metrics: {
          overall_score: 0,
          hard_logic_score: 0,
          low_position_score: 0,
          turning_point_score: 0,
          risk_position_score: 0
        },
        generated_by: "Atlas",
        generated_at: nowIso(),
        is_mock: dataPack.is_mock
      };
    }

    const aegis = agentResults.Aegis;
    let action = (aegis?.metrics.action as StrategyAction | undefined) ?? "observe";
    const criticalFailed = Object.entries(agentResults).some(
      ([name, result]) => ["Argus", "Logos", "Nadir", "Vega", "Aegis"].includes(name) && result.status === "failed"
    );
    if (criticalFailed && ["trial_buy", "staged_buy"].includes(action)) action = "observe";
    if (!dataPack.allow_strong_conclusion && action !== "observe") action = "observe";

    const overallScore = Number(aegis?.score ?? 0);
    let riskLevel: RiskLevel = "low";
    if (["reduce", "exit", "avoid"].includes(action) || overallScore < 45) riskLevel = "high";
    else if (["observe", "trial_buy"].includes(action)) riskLevel = "medium";

    return {
      action,
      confidence: aegis?.confidence ?? 0.4,
      risk_level: riskLevel,
      summary: `Atlas 审阅：${dataPack.fund_name} 当前建议为 ${action}，需结合风险预算分批验证。`,
      reasons: [
        agentResults.Logos?.summary ?? "Logos 未输出。",
        agentResults.Nadir?.summary ?? "Nadir 未输出。",
        agentResults.Vega?.summary ?? "Vega 未输出。",
        aegis?.summary ?? "Aegis 未输出。"
      ],
      risk_warnings: [
        ...(!dataPack.allow_strong_conclusion ? ["Argus 未允许强结论；Atlas 已将内部状态降级为 observe，仅保留证据复核。"] : []),
        dataPack.data_status === "demo"
          ? "当前结论基于 demo fixture 数据，仅用于产品与后端流程验证。"
          : "当前结论依赖 Argus 获取的数据质量，必须保留来源追溯和降级规则。",
        "本系统不提供收益保证，也不执行真实交易。",
        ...(aegis?.warnings ?? [])
      ],
      invalidation_conditions: aegis?.next_suggestions ?? [],
      source_agents: ["Argus", "Logos", "Nadir", "Vega", "Aegis", "Atlas"],
      metrics: {
        overall_score: Number(overallScore.toFixed(2)),
        hard_logic_score: Number(agentResults.Logos?.score ?? 0),
        low_position_score: Number(agentResults.Nadir?.score ?? 0),
        turning_point_score: Number(agentResults.Vega?.score ?? 0),
        risk_position_score: Number(aegis?.score ?? 0)
      },
      generated_by: "Atlas",
      generated_at: nowIso(),
      is_mock: dataPack.is_mock
    };
  }
}
