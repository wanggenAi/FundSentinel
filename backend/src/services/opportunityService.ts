import { SourceRegistry } from "../dataSources/index.js";
import type { FundAnalysisResponse, OpportunityCandidate, OpportunitySquareResponse, StrategyAction } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";
import { FundAnalysisService } from "./fundAnalysisService.js";
import { MockDataService } from "./mockDataService.js";

export interface OpportunityServiceOptions {
  fundUniverse?: string[];
  demoMode?: boolean;
}

export class OpportunityService {
  private readonly fundUniverse: string[];
  private readonly demoMode: boolean;

  constructor(
    private readonly mockDataService = new MockDataService(),
    private readonly fundAnalysisService = new FundAnalysisService(new SourceRegistry()),
    options: OpportunityServiceOptions = {}
  ) {
    this.demoMode = options.demoMode ?? process.env.FUNDSENTINEL_DEMO_MODE === "true";
    this.fundUniverse = options.fundUniverse ?? OpportunityService.parseFundUniverse(process.env.FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE);
  }

  async getOpportunities(limit = 6): Promise<OpportunitySquareResponse> {
    const boundedLimit = Math.max(1, Math.min(limit, 10));
    const universe = this.activeFundUniverse().slice(0, boundedLimit);
    if (!universe.length) return this.emptyResponse("采基广场未配置真实基金候选池；设置 FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE 后才会请求真实 provider。");

    const analyses = await Promise.all(universe.map((fundCode) => this.fundAnalysisService.analyzeFund(fundCode, `opportunity-${fundCode}`)));
    const candidates = analyses
      .filter((analysis) => analysis.data_pack.allow_downstream_analysis)
      .map((analysis) => this.candidateFromAnalysis(analysis))
      .sort((a, b) => b.overall_opportunity_score - a.overall_opportunity_score);
    const qualityScore = candidates.length ? Math.min(...candidates.map((candidate) => candidate.confidence)) : 0;
    return {
      is_mock: candidates.some((candidate) => candidate.is_mock),
      candidates,
      summary: candidates.length ? "Atlas 已基于可用数据生成候选池；候选不等于买入，动作以 Aegis 风险仓位建议为准。" : "真实核心数据不可用，Argus 已阻止采基广场生成伪候选基金。",
      data_quality: {
        level: qualityScore >= 0.7 ? "high" : qualityScore >= 0.5 ? "medium" : "low",
        score: Number(qualityScore.toFixed(2)),
        source: "Atlas + Argus SourceRegistry",
        updated_at: nowIso(),
        warnings: candidates.length ? [] : ["没有真实可用核心数据，采基广场不会输出伪推荐。"],
        is_mock: false
      },
      generated_by: "Atlas",
      generated_at: nowIso()
    };
  }

  private activeFundUniverse(): string[] {
    if (this.fundUniverse.length) return this.fundUniverse;
    if (!this.demoMode) return [];
    return this.mockDataService.getFundUniverse().map((fund) => fund.fund_code);
  }

  private emptyResponse(summary: string): OpportunitySquareResponse {
    return {
      is_mock: false,
      candidates: [],
      summary,
      data_quality: {
        level: "low",
        score: 0,
        source: "Atlas + Argus SourceRegistry",
        updated_at: nowIso(),
        warnings: [summary],
        is_mock: false
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
      is_mock: analysis.is_mock
    };
  }

  private static parseFundUniverse(value?: string): string[] {
    return [
      ...new Set(
        (value ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter((item) => /^\d{6}$/u.test(item))
      )
    ];
  }
}
