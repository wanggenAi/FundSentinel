import type { FundAnalysisResponse, OpportunityCandidate, OpportunitySquareResponse, StrategyAction } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";
import { FundAnalysisService } from "./fundAnalysisService.js";
import { MockDataService } from "./mockDataService.js";

export class OpportunityService {
  constructor(
    private readonly mockDataService = new MockDataService(),
    private readonly fundAnalysisService = new FundAnalysisService(mockDataService)
  ) {}

  async getOpportunities(limit = 6): Promise<OpportunitySquareResponse> {
    const boundedLimit = Math.max(1, Math.min(limit, 10));
    const universe = this.mockDataService.getFundUniverse().slice(0, boundedLimit);
    const analyses = await Promise.all(
      universe.map((fund) => this.fundAnalysisService.analyzeFund(fund.fund_code, `opportunity-${fund.fund_code}`))
    );
    const candidates = analyses.map((analysis) => this.candidateFromAnalysis(analysis)).sort((a, b) => b.overall_opportunity_score - a.overall_opportunity_score);
    const qualityScore = candidates.length ? Math.min(...candidates.map((candidate) => candidate.confidence)) : 0;
    return {
      is_mock: true,
      candidates,
      summary: "Atlas 已基于 mock 多 Agent 结果生成候选池；候选不等于买入，动作以 Aegis 风险仓位建议为准。",
      data_quality: {
        level: qualityScore >= 0.7 ? "high" : qualityScore >= 0.5 ? "medium" : "low",
        score: Number(qualityScore.toFixed(2)),
        source: "Atlas + MockDataService",
        updated_at: nowIso(),
        warnings: ["采基广场当前全部使用 mock 数据，不代表真实基金推荐。"],
        is_mock: true
      },
      generated_by: "Atlas",
      generated_at: nowIso()
    };
  }

  private candidateFromAnalysis(analysis: FundAnalysisResponse): OpportunityCandidate {
    const metrics = analysis.final_decision.metrics;
    let action = analysis.final_decision.action as StrategyAction;
    if (action === "staged_buy" && analysis.data_pack.data_quality.level === "low") action = "observe";
    const overall =
      metrics.hard_logic_score * 0.28 +
      metrics.low_position_score * 0.24 +
      metrics.turning_point_score * 0.22 +
      metrics.risk_position_score * 0.18 +
      analysis.data_pack.data_quality.score * 100 * 0.08;
    const risks = [
      ...Object.values(analysis.agent_results).flatMap((result) => result.warnings),
      ...analysis.final_decision.risk_warnings
    ];
    return {
      fund_code: analysis.fund_code,
      fund_name: analysis.fund_name,
      fund_type: analysis.data_pack.fund_type,
      themes: analysis.data_pack.themes,
      current_nav: analysis.data_pack.current_nav,
      daily_return: analysis.data_pack.daily_return,
      hard_logic_score: Number(metrics.hard_logic_score.toFixed(2)),
      low_position_score: Number(metrics.low_position_score.toFixed(2)),
      turning_point_score: Number(metrics.turning_point_score.toFixed(2)),
      risk_position_score: Number(metrics.risk_position_score.toFixed(2)),
      overall_opportunity_score: Number(Math.max(0, Math.min(100, overall)).toFixed(2)),
      action,
      confidence: analysis.final_decision.confidence,
      reason_summary: analysis.final_decision.summary,
      risk_summary: risks[0] ?? "未发现高优先级风险，但仍需等待真实数据验证。",
      key_evidence: ["Logos", "Nadir", "Vega", "Aegis"].flatMap((name) => analysis.agent_results[name]?.evidence.slice(0, 1) ?? []),
      is_mock: true
    };
  }
}

