import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FundDataPack, StrategyAction } from "../schemas/index.js";
import { clamp } from "../schemas/index.js";

export class AegisAgent extends BaseAgent {
  readonly name = "Aegis";
  readonly role = "Risk & Position Manager Agent";
  readonly responsibilities = [
    "根据专业 Agent 结果形成风险复核状态",
    "输出内部 observe、trial_buy、staged_buy、hold、reduce、exit、avoid 等状态供 Atlas 降级审阅",
    "在数据质量低、模块冲突或关键 Agent 失败时降级建议"
  ];

  async run(taskId: string, dataPack: FundDataPack, agentResults: Record<"Logos" | "Nadir" | "Vega", AgentResult>): Promise<AgentResult> {
    const aiResponse = await this.askAI({
      taskId,
      fundCode: dataPack.fund_code,
      prompt: "Review position action from structured agent scores. Downgrade if conflicts or data quality problems exist.",
      context: { fund: dataPack, agent_results: agentResults }
    });
    const logos = agentResults.Logos;
    const nadir = agentResults.Nadir;
    const vega = agentResults.Vega;
    const scores = [logos.score ?? 0, nadir.score ?? 0, vega.score ?? 0];
    const weightedScore = scores[0] * 0.32 + scores[1] * 0.28 + scores[2] * 0.25 + dataPack.data_quality.score * 15;
    const criticalFailed = [logos, nadir, vega].some((result) => result.status === "failed");
    const lowQuality = dataPack.data_quality.level === "low";
    const conflict = Math.max(...scores) - Math.min(...scores) >= 42;
    const warnings: string[] = [];
    if (lowQuality) warnings.push("数据质量 low，Aegis 不允许输出 staged_buy。");
    if (criticalFailed) warnings.push("关键 Agent failed，策略建议降级。");
    if (conflict) warnings.push("硬逻辑、低位、拐点评分分歧较大，建议强度降级。");
    if (aiResponse.available && aiResponse.content) warnings.push("已调用统一 AI API 辅助审阅；V0.1 仍以结构化规则输出为准。");

    let action = this.decideAction(weightedScore, logos, nadir, vega);
    if (lowQuality && ["staged_buy", "trial_buy"].includes(action)) action = "observe";
    if (criticalFailed && ["staged_buy", "trial_buy"].includes(action)) action = "observe";
    if (conflict && action === "staged_buy") action = "trial_buy";
    if ((vega.score ?? 0) < 28) action = (logos.score ?? 0) < 55 ? "avoid" : "observe";
    if ((logos.score ?? 0) < 35) action = "avoid";

    let confidence = Math.min(logos.confidence, nadir.confidence, vega.confidence);
    if (warnings.length) confidence = Math.min(confidence, 0.55);
    const evidence: EvidenceItem[] = [
      {
        title: "仓位策略综合规则",
        source_name: dataPack.is_mock ? "Aegis V0.1 demo rules" : "Aegis V0.1 rules",
        source_type: dataPack.is_mock ? "mock" : "official",
        trust_level: "C",
        summary: "综合硬逻辑、低位、拐点和数据质量，输出保守仓位动作。",
        importance_score: 0.82,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      }
    ];

    return this.buildResult({
      taskId,
      fundCode: dataPack.fund_code,
      status: warnings.length ? "warning" : "success",
      score: Number(clamp(weightedScore).toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
      summary: `风险复核状态为 ${action}；${dataPack.is_mock ? "当前基于 demo/mock 数据，仅用于流程验证。" : "仅用于证据复核排序，不是交易指令。"}`,
      evidence,
      metrics: {
        action,
        weighted_score: Number(weightedScore.toFixed(2)),
        hard_logic_score: logos.score,
        low_position_score: nadir.score,
        turning_point_score: vega.score,
        data_quality_score: dataPack.data_quality.score,
        conflict_detected: conflict,
        critical_failed: criticalFailed,
        ai_gateway_available: aiResponse.available,
        ai_model: aiResponse.model
      },
      warnings,
      nextSuggestions: [
        "仅作为风险复核状态，不触发真实交易或账户操作。",
        "基金净值重新跌破近期低点且 Vega 转为 falling 时降级复核状态。",
        "行业硬逻辑证据被政策或产业数据证伪时复核假设。",
        "数据源质量降为 low 或关键数据超过预期更新时间时暂停强结论。"
      ],
      isMock: dataPack.is_mock
    });
  }

  private decideAction(weightedScore: number, logos: AgentResult, nadir: AgentResult, vega: AgentResult): StrategyAction {
    if ((logos.score ?? 0) >= 72 && (nadir.score ?? 0) >= 62 && (vega.score ?? 0) >= 68 && weightedScore >= 72) {
      return "staged_buy";
    }
    if ((logos.score ?? 0) >= 62 && (nadir.score ?? 0) >= 55 && (vega.score ?? 0) >= 55) return "trial_buy";
    if (weightedScore >= 58) return "observe";
    if ((vega.score ?? 0) < 35) return "reduce";
    return "avoid";
  }
}
