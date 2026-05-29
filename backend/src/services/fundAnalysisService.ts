import { randomUUID } from "node:crypto";
import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import { SourceRegistry } from "../dataSources/index.js";
import { SharedBlackboard, FundAnalysisDagRunner } from "../orchestration/index.js";
import type { AgentResult, FundAnalysisResponse, FundDataPack, OpportunityReviewStatus } from "../schemas/index.js";
import { sanitizePublicText } from "../utils/publicText.js";
import { AIGateway } from "./aiGateway.js";

export interface PublicFundAnalysisResponse {
  task_id: string;
  fund_code: string;
  fund_name: string;
  is_mock: boolean;
  data_status: FundDataPack["data_status"];
  data_pack: PublicFundDataPack;
  agent_results: Record<string, PublicAgentResult>;
  final_review: PublicFinalReview;
  traceability: {
    data_sources: Array<Record<string, unknown>>;
    data_gap_report: FundDataPack["data_gap_report"];
    acquisition_solutions: FundDataPack["acquisition_solutions"];
  };
  generated_at: string;
}

export type PublicFundDataPack = Pick<
  FundDataPack,
  | "fund_code"
  | "fund_name"
  | "fund_type"
  | "themes"
  | "current_nav"
  | "daily_return"
  | "nav_history_dates"
  | "portfolio_holdings"
  | "fund_report_refs"
  | "fund_report_documents"
  | "policy_signals"
  | "macro_indicators"
  | "news_summaries"
  | "data_quality_report"
  | "data_status"
  | "allow_downstream_analysis"
  | "allow_strong_conclusion"
  | "data_quality"
  | "updated_at"
  | "generated_at"
  | "is_mock"
>;

export type PublicAgentResult = Omit<AgentResult, "metrics" | "next_suggestions"> & {
  metrics: Record<string, unknown>;
  next_suggestions: string[];
};

export interface PublicFinalReview {
  review_status: OpportunityReviewStatus;
  confidence: number;
  risk_level: FundAnalysisResponse["final_decision"]["risk_level"];
  summary: string;
  reasons: string[];
  risk_warnings: string[];
  invalidation_conditions: string[];
  source_agents: string[];
  metrics: Record<string, number>;
  generated_by: "Atlas";
  generated_at: string;
  is_mock: boolean;
}

export class FundAnalysisService {
  constructor(
    private readonly sourceRegistry = new SourceRegistry(),
    private readonly aiGateway = new AIGateway()
  ) {}

  async analyzeFund(fundCode: string, taskId = `fund-analysis-${randomUUID().slice(0, 12)}`): Promise<FundAnalysisResponse> {
    const blackboard = new SharedBlackboard();
    const atlas = new AtlasAgent(this.aiGateway);
    const runner = new FundAnalysisDagRunner({
      argus: new ArgusAgent(this.sourceRegistry, this.aiGateway),
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
      is_mock: dataPack.is_mock,
      data_pack: dataPack,
      agent_results: agentResults,
      final_decision: finalDecision,
      blackboard_snapshot: blackboard.exportSnapshot(taskId),
      generated_at: finalDecision.generated_at
    };
  }

  async analyzeFundPublic(fundCode: string, taskId?: string): Promise<PublicFundAnalysisResponse> {
    return this.presentPublicFundAnalysis(await this.analyzeFund(fundCode, taskId));
  }

  presentPublicFundAnalysis(response: FundAnalysisResponse): PublicFundAnalysisResponse {
    return {
      task_id: response.task_id,
      fund_code: response.fund_code,
      fund_name: response.fund_name,
      is_mock: response.is_mock,
      data_status: response.data_pack.data_status,
      data_pack: this.publicDataPack(response.data_pack),
      agent_results: Object.fromEntries(
        Object.entries(response.agent_results).map(([agentName, result]) => [agentName, this.publicAgentResult(result)])
      ),
      final_review: this.publicFinalReview(response),
      traceability: {
        data_sources: this.sanitizeStructured(response.data_pack.data_sources) as Array<Record<string, unknown>>,
        data_gap_report: this.sanitizeStructured(response.data_pack.data_gap_report) as FundDataPack["data_gap_report"],
        acquisition_solutions: this.sanitizeStructured(response.data_pack.acquisition_solutions) as FundDataPack["acquisition_solutions"]
      },
      generated_at: response.generated_at
    };
  }

  private publicDataPack(dataPack: FundDataPack): PublicFundDataPack {
    const publicPack: PublicFundDataPack = {
      fund_code: dataPack.fund_code,
      fund_name: dataPack.fund_name,
      fund_type: dataPack.fund_type,
      themes: dataPack.themes,
      current_nav: dataPack.current_nav,
      daily_return: dataPack.daily_return,
      nav_history_dates: dataPack.nav_history_dates,
      portfolio_holdings: dataPack.portfolio_holdings,
      fund_report_refs: dataPack.fund_report_refs,
      fund_report_documents: dataPack.fund_report_documents,
      policy_signals: dataPack.policy_signals,
      macro_indicators: dataPack.macro_indicators,
      news_summaries: dataPack.news_summaries,
      data_quality_report: dataPack.data_quality_report,
      data_status: dataPack.data_status,
      allow_downstream_analysis: dataPack.allow_downstream_analysis,
      allow_strong_conclusion: dataPack.allow_strong_conclusion,
      data_quality: dataPack.data_quality,
      updated_at: dataPack.updated_at,
      generated_at: dataPack.generated_at,
      is_mock: dataPack.is_mock
    };
    return this.sanitizeStructured(publicPack) as PublicFundDataPack;
  }

  private publicAgentResult(result: AgentResult): PublicAgentResult {
    return {
      ...result,
      agent_role: this.publicAgentRole(result),
      summary: this.sanitizeText(result.summary),
      metrics: this.publicMetrics(result.metrics),
      warnings: result.warnings.map((warning) => this.sanitizeText(warning)),
      next_suggestions: result.next_suggestions.map((suggestion) => this.sanitizeText(suggestion)),
      evidence: result.evidence.map((item) => ({
        ...item,
        title: this.sanitizeText(item.title),
        source_name: this.sanitizeText(item.source_name),
        summary: this.sanitizeText(item.summary)
      }))
    };
  }

  private publicAgentRole(result: AgentResult): string {
    const map: Record<string, string> = {
      Aegis: "Risk Review Agent",
      Nadir: "Valuation Review Agent"
    };
    return map[result.agent_name] ?? this.sanitizeText(result.agent_role);
  }

  private publicFinalReview(response: FundAnalysisResponse): PublicFinalReview {
    const finalDecision = response.final_decision;
    return {
      review_status: this.reviewStatusForAnalysis(response),
      confidence: finalDecision.confidence,
      risk_level: finalDecision.risk_level,
      summary: this.finalReviewSummary(response),
      reasons: finalDecision.reasons.map((reason) => this.sanitizeText(reason)),
      risk_warnings: finalDecision.risk_warnings.map((warning) => this.sanitizeText(warning)),
      invalidation_conditions: finalDecision.invalidation_conditions.map((condition) => this.sanitizeText(condition)),
      source_agents: finalDecision.source_agents,
      metrics: this.publicNumericMetrics(finalDecision.metrics),
      generated_by: finalDecision.generated_by,
      generated_at: finalDecision.generated_at,
      is_mock: finalDecision.is_mock
    };
  }

  private reviewStatusForAnalysis(response: FundAnalysisResponse): OpportunityReviewStatus {
    if (!response.data_pack.allow_downstream_analysis || ["unavailable", "insufficient"].includes(response.data_pack.data_status)) return "data_gap_review";
    if (!response.data_pack.allow_strong_conclusion) return "evidence_review";
    if (response.final_decision.risk_level === "high") return "risk_review";
    if (response.data_pack.data_quality.level === "low" || response.final_decision.confidence < 0.55) return "evidence_review";
    return "observe";
  }

  private finalReviewSummary(response: FundAnalysisResponse): string {
    const status = this.reviewStatusForAnalysis(response);
    if (status === "data_gap_review") return `${response.fund_code} 真实核心数据不足，仅返回数据缺口、来源和补齐方案。`;
    if (status === "risk_review") return `${response.fund_name} 被 Atlas 标记为高风险复核项，需先核对证据链和失效条件。`;
    if (status === "evidence_review") {
      if (!response.data_pack.allow_strong_conclusion) return this.degradedFinalReviewSummary(response);
      return `${response.fund_name} 的数据质量或置信度仍需复核，仅进入观察。`;
    }
    return `${response.fund_name} 已完成证据审阅，仅进入观察；不代表交易动作。`;
  }

  private degradedFinalReviewSummary(response: FundAnalysisResponse): string {
    const quality = response.data_pack.data_quality_report;
    const missing = [...new Set([...quality.missing_core_fields, ...quality.missing_auxiliary_fields])];
    const details = [
      missing.length ? `缺口=${missing.slice(0, 5).join(", ")}` : null,
      quality.stale_sources.length ? `stale_sources=${quality.stale_sources.join(", ")}` : null,
      quality.nav_consistency_report.status === "conflict" ? "nav_consistency=conflict" : null
    ].filter(Boolean);
    return `${response.fund_name} 仅进入证据复核：Argus 未允许强结论${details.length ? `，${details.join("；")}` : ""}。`;
  }

  private publicMetrics(metrics: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(metrics)
        .filter(([key]) => !["action", "buy", "sell", "position"].includes(key))
        .map(([key, value]) => [this.publicMetricKey(key), this.sanitizeStructured(value)])
    );
  }

  private publicNumericMetrics(metrics: Record<string, number>): Record<string, number> {
    return Object.fromEntries(
      Object.entries(metrics)
        .filter(([key]) => !["action", "buy", "sell", "position"].includes(key))
        .map(([key, value]) => [this.publicMetricKey(key), value])
    );
  }

  private publicMetricKey(key: string): string {
    const map: Record<string, string> = {
      low_position_score: "low_nav_score",
      risk_position_score: "risk_review_score"
    };
    return map[key] ?? key;
  }

  private sanitizeStructured(value: unknown): unknown {
    if (typeof value === "string") return sanitizePublicText(value);
    if (Array.isArray(value)) return value.map((item) => this.sanitizeStructured(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.publicMetricKey(key), this.sanitizeStructured(item)]));
    }
    return value;
  }

  private sanitizeText(value: string): string {
    return sanitizePublicText(value);
  }
}
