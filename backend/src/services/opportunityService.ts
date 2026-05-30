import { SourceRegistry } from "../dataSources/index.js";
import type { EvidenceItem, FundAnalysisResponse, OpportunityCandidate, OpportunityReviewStatus, OpportunitySquareResponse } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";
import { sanitizePublicStructure, sanitizePublicText } from "../utils/publicText.js";
import { FundAnalysisService } from "./fundAnalysisService.js";
import { MockDataService } from "./mockDataService.js";

export interface OpportunityServiceOptions {
  fundUniverse?: string[];
  demoMode?: boolean;
  enableLiveProviders?: boolean;
}

interface ParsedFundUniverse {
  valid: string[];
  invalid: string[];
}

export class OpportunityService {
  private readonly fundUniverse: string[];
  private readonly invalidFundUniverseEntries: string[];
  private readonly fundUniverseSourceName: string | null;
  private readonly demoMode: boolean;
  private readonly fundAnalysisService: FundAnalysisService;

  constructor(
    private readonly mockDataService = new MockDataService(),
    fundAnalysisService?: FundAnalysisService,
    options: OpportunityServiceOptions = {}
  ) {
    this.demoMode = options.demoMode ?? process.env.FUNDSENTINEL_DEMO_MODE === "true";
    this.fundAnalysisService =
      fundAnalysisService ??
      new FundAnalysisService(
        new SourceRegistry({
          demoMode: this.demoMode,
          enableLiveProviders: options.enableLiveProviders
        })
      );
    this.fundUniverseSourceName = options.fundUniverse ? "OpportunityService options fundUniverse" : process.env.FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE ? "FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE" : null;
    const parsedFundUniverse = OpportunityService.parseFundUniverse(options.fundUniverse ?? process.env.FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE);
    this.fundUniverse = parsedFundUniverse.valid;
    this.invalidFundUniverseEntries = parsedFundUniverse.invalid;
  }

  async getOpportunities(limit = 6): Promise<OpportunitySquareResponse> {
    const boundedLimit = Math.max(1, Math.min(limit, 10));
    const universe = this.activeFundUniverse().slice(0, boundedLimit);
    const universeAudit = this.universeAudit(universe, boundedLimit);
    if (!universe.length) return this.emptyResponse("采基广场未配置真实基金候选池；设置 FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE 后才会请求真实 provider。", universeAudit);

    const analysisSettlements = await Promise.allSettled(universe.map((fundCode) => this.fundAnalysisService.analyzeFund(fundCode, `opportunity-${fundCode}`)));
    const analyses = analysisSettlements.flatMap((settlement) => (settlement.status === "fulfilled" ? [settlement.value] : []));
    const failedAnalyses = analysisSettlements.flatMap((settlement, index) =>
      settlement.status === "rejected"
        ? [
            {
              fund_code: universe[index] ?? "unknown",
              error: this.publicText(settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason))
            }
          ]
        : []
    );
    const candidates = analyses
      .filter((analysis) => analysis.data_pack.allow_downstream_analysis)
      .map((analysis) => this.candidateFromAnalysis(analysis))
      .sort((a, b) => b.overall_opportunity_score - a.overall_opportunity_score);
    const candidateQualityScore = candidates.length ? Math.min(...candidates.map((candidate) => candidate.confidence)) : 0;
    const qualityScore = failedAnalyses.length ? Math.min(candidateQualityScore, 0.4) : candidateQualityScore;
    const isMock = candidates.some((candidate) => candidate.is_mock);
    const degradedWarnings = this.degradedAnalysisWarnings(analyses);
    const failureWarnings = failedAnalyses.map((failure) => `${failure.fund_code} 候选分析失败：${failure.error}；该基金已从候选池剔除并保留数据源复核。`);
    return this.publicResponse({
      is_mock: isMock,
      candidates,
      summary: candidates.length
        ? degradedWarnings.length || failureWarnings.length
          ? "Atlas 已生成候选复核池；部分候选存在数据缺口或强结论限制，仅作为证据补齐优先级，不代表交易指令。"
          : "Atlas 已基于可用数据生成候选观察池；候选仅表示证据复核优先级，不代表交易指令。"
        : failedAnalyses.length
          ? "部分或全部基金分析链路失败，Argus 已阻止采基广场生成伪候选基金。"
          : "真实核心数据不可用，Argus 已阻止采基广场生成伪候选基金。",
      data_quality: {
        level: qualityScore >= 0.7 ? "high" : qualityScore >= 0.5 ? "medium" : "low",
        score: Number(qualityScore.toFixed(2)),
        source: `Atlas + Argus SourceRegistry + ${universeAudit.source_name}`,
        updated_at: nowIso(),
        warnings: candidates.length || failureWarnings.length || this.invalidFundUniverseEntries.length
          ? [...this.universeWarnings(), ...degradedWarnings, ...failureWarnings]
          : ["没有真实可用核心数据，采基广场不会输出伪推荐。"],
        is_mock: isMock
      },
      universe_audit: universeAudit,
      generated_by: "Atlas",
      generated_at: nowIso()
    });
  }

  private activeFundUniverse(): string[] {
    if (this.fundUniverse.length) return this.fundUniverse;
    if (this.fundUniverseSourceName) return [];
    if (!this.demoMode) return [];
    return this.mockDataService.getFundUniverse().map((fund) => fund.fund_code);
  }

  private emptyResponse(summary: string, universeAudit: OpportunitySquareResponse["universe_audit"]): OpportunitySquareResponse {
    return this.publicResponse({
      is_mock: false,
      candidates: [],
      summary,
      data_quality: {
        level: "low",
        score: 0,
        source: `Atlas + Argus SourceRegistry + ${universeAudit.source_name}`,
        updated_at: nowIso(),
        warnings: [...this.universeWarnings(), summary],
        is_mock: false
      },
      universe_audit: universeAudit,
      generated_by: "Atlas",
      generated_at: nowIso()
    });
  }

  private universeAudit(selectedFundCodes: string[], requestedLimit: number): OpportunitySquareResponse["universe_audit"] {
    const configuredCount = this.fundUniverse.length;
    const usingConfiguredSource = Boolean(this.fundUniverseSourceName);
    const usingDemo = !usingConfiguredSource && this.demoMode;
    return {
      source_type: usingConfiguredSource ? this.configuredUniverseSourceType() : usingDemo ? "demo_fixture" : "unconfigured",
      source_name: usingConfiguredSource ? this.fundUniverseSourceName ?? "configured fund universe" : usingDemo ? "MockDataService demo fund universe" : "unconfigured",
      configured_count: usingConfiguredSource ? configuredCount : usingDemo ? this.mockDataService.getFundUniverse().length : 0,
      selected_count: selectedFundCodes.length,
      requested_limit: requestedLimit,
      selected_fund_codes: selectedFundCodes,
      ignored_invalid_fund_codes: this.invalidFundUniverseEntries,
      is_mock: usingDemo
    };
  }

  private universeWarnings(): string[] {
    return this.invalidFundUniverseEntries.length
      ? [`${this.fundUniverseSourceName ?? "机会广场候选池配置"} 含有无效基金代码，已忽略：${this.invalidFundUniverseEntries.join(", ")}。`]
      : [];
  }

  private configuredUniverseSourceType(): OpportunitySquareResponse["universe_audit"]["source_type"] {
    return this.fundUniverseSourceName === "FUNDSENTINEL_OPPORTUNITY_FUND_UNIVERSE" ? "configured_env" : "configured_options";
  }

  private candidateFromAnalysis(analysis: FundAnalysisResponse): OpportunityCandidate {
    const metrics = analysis.final_decision.metrics;
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
      low_nav_score: Number(metrics.low_position_score.toFixed(2)),
      turning_point_score: Number(metrics.turning_point_score.toFixed(2)),
      risk_review_score: Number(metrics.risk_position_score.toFixed(2)),
      overall_opportunity_score: Number(Math.max(0, Math.min(100, overall)).toFixed(2)),
      review_status: this.reviewStatusForAnalysis(analysis),
      confidence: analysis.final_decision.confidence,
      reason_summary: this.reasonSummary(analysis),
      risk_summary: this.publicText(risks[0] ?? "未发现高优先级风险，但仍需等待真实数据验证。"),
      key_evidence: ["Logos", "Nadir", "Vega"].flatMap((name) => analysis.agent_results[name]?.evidence.slice(0, 1).map((item) => this.publicEvidence(item)) ?? []),
      is_mock: analysis.is_mock
    };
  }

  private reviewStatusForAnalysis(analysis: FundAnalysisResponse): OpportunityReviewStatus {
    if (!analysis.data_pack.allow_downstream_analysis || ["unavailable", "insufficient"].includes(analysis.data_pack.data_status)) return "data_gap_review";
    if (!analysis.data_pack.allow_strong_conclusion) return "evidence_review";
    if (analysis.final_decision.risk_level === "high") return "risk_review";
    if (analysis.data_pack.data_quality.level === "low" || analysis.final_decision.confidence < 0.55) return "evidence_review";
    return "observe";
  }

  private reasonSummary(analysis: FundAnalysisResponse): string {
    const status = this.reviewStatusForAnalysis(analysis);
    if (status === "data_gap_review") return "真实核心数据不足，候选仅保留为数据补齐复核项。";
    if (status === "risk_review") return "Atlas 标记为高风险复核项，需先核对风险提示和失效条件。";
    if (status === "evidence_review") {
      if (!analysis.data_pack.allow_strong_conclusion) {
        const missing = [
          ...analysis.data_pack.data_quality_report.missing_core_fields,
          ...analysis.data_pack.data_quality_report.missing_auxiliary_fields
        ];
        return `Argus 未允许强结论；候选仅作为证据补齐复核项${missing.length ? `，优先修复 ${missing.slice(0, 4).join(", ")}` : ""}。`;
      }
      return "数据质量或置信度仍需复核，候选只进入观察池。";
    }
    return "Atlas 已完成证据审阅，候选进入观察池；不代表交易指令。";
  }

  private degradedAnalysisWarnings(analyses: FundAnalysisResponse[]): string[] {
    return [
      ...new Set(
        analyses
          .filter((analysis) => analysis.data_pack.allow_downstream_analysis && !analysis.data_pack.allow_strong_conclusion)
          .flatMap((analysis) => {
            const quality = analysis.data_pack.data_quality_report;
            const missing = [...new Set([...quality.missing_core_fields, ...quality.missing_auxiliary_fields])];
            const warnings = [
              `${analysis.fund_code} 仅进入证据复核：Argus 未允许强结论${
                missing.length ? `，缺口=${missing.slice(0, 5).join(", ")}` : ""
              }。`
            ];
            if (quality.stale_sources.length) warnings.push(`${analysis.fund_code} 存在 stale 数据源：${quality.stale_sources.join(", ")}。`);
            if (quality.nav_consistency_report.status === "conflict") warnings.push(`${analysis.fund_code} 存在 NAV 跨源冲突，需先复核净值来源。`);
            return warnings;
          })
      )
    ].map((warning) => this.publicText(warning));
  }

  private publicEvidence(item: EvidenceItem): EvidenceItem {
    return {
      ...item,
      title: this.publicText(item.title),
      source_name: this.publicText(item.source_name),
      summary: this.publicText(item.summary),
      url: item.url ? this.publicText(item.url) : null,
      related_theme: item.related_theme ? this.publicText(item.related_theme) : null
    };
  }

  private publicText(value: string): string {
    return sanitizePublicText(value);
  }

  private publicResponse(response: OpportunitySquareResponse): OpportunitySquareResponse {
    return sanitizePublicStructure(response);
  }

  private static parseFundUniverse(value?: string | string[]): ParsedFundUniverse {
    const rawItems = Array.isArray(value) ? value : (value ?? "").split(",");
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const item of rawItems.map((entry) => entry.trim()).filter(Boolean)) {
      if (/^\d{6}$/u.test(item)) valid.push(item);
      else invalid.push(item);
    }
    return {
      valid: [...new Set(valid)],
      invalid: [...new Set(invalid)]
    };
  }
}
