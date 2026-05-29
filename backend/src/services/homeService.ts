import type { FundAnalysisResponse, HomeDashboardResponse, RiskLevel, TodayFocusItem } from "../schemas/index.js";
import { FundAnalysisService } from "./fundAnalysisService.js";
import { PortfolioService } from "./portfolioService.js";
import { StrategyTriggerService } from "./strategyTriggerService.js";

export class HomeService {
  constructor(
    private readonly portfolioService = new PortfolioService(),
    private readonly fundAnalysisService = new FundAnalysisService(),
    private readonly strategyTriggerService = new StrategyTriggerService()
  ) {}

  async getHomeDashboard(userId = "mock-user"): Promise<HomeDashboardResponse> {
    const portfolio = this.portfolioService.getPortfolioSnapshot(userId);
    const analyses = await Promise.all(
      portfolio.holdings.map((holding) => this.fundAnalysisService.analyzeFund(holding.fund_code, `home-${holding.fund_code}`))
    );
    const actionableAnalyses = analyses.filter((analysis) => analysis.data_pack.allow_downstream_analysis);
    const strategyTriggers = this.strategyTriggerService.buildTriggers(actionableAnalyses);
    const blockedFunds = analyses.filter((analysis) => !analysis.data_pack.allow_downstream_analysis);
    const degradedFunds = actionableAnalyses.filter((analysis) => !analysis.data_pack.allow_strong_conclusion);
    const analysisIsMock = analyses.some((analysis) => analysis.is_mock || analysis.data_pack.is_mock || analysis.data_pack.data_quality.is_mock);
    const analysisWarnings = this.analysisQualityWarnings(analyses);
    const homeQualityScore = this.homeQualityScore(portfolio.data_quality.score, analyses);
    const homeIsMock = portfolio.is_mock || analysisIsMock;
    const homeDataQuality = {
      ...portfolio.data_quality,
      level: this.dataQualityLevel(homeQualityScore),
      score: homeQualityScore,
      warnings: [
        ...portfolio.data_quality.warnings,
        ...analysisWarnings,
        ...(analysisIsMock ? ["首页基金分析链路包含 demo/mock 数据；首页整体仅可作为本地演示或测试输出。"] : [])
      ],
      is_mock: homeIsMock
    };
    const portfolioGapFocus =
      portfolio.holdings.length === 0 && portfolio.data_quality.warnings.length
        ? [
            {
              title: "真实持仓未配置",
              summary: portfolio.data_quality.warnings[0] ?? "首页持仓缺少真实来源，Atlas 已返回降级状态。",
              priority: "high" as const,
              related_funds: [],
              is_mock: portfolio.is_mock
            }
          ]
        : [];
    return {
      is_mock: homeIsMock,
      total_assets: portfolio.total_assets,
      daily_pnl: portfolio.daily_pnl,
      daily_pnl_ratio: portfolio.daily_pnl_ratio,
      holding_count: portfolio.holdings.length,
      risk_level: this.homeRiskLevel(strategyTriggers.map((trigger) => trigger.priority)),
      strategy_triggers: strategyTriggers,
      holding_alerts: this.strategyTriggerService.buildHoldingAlerts(actionableAnalyses),
      today_focus: [
        ...portfolioGapFocus,
        ...this.degradedAnalysisFocus(degradedFunds),
        ...this.strategyTriggerService.buildTodayFocus(strategyTriggers),
        ...blockedFunds.slice(0, 3).map((analysis) => ({
          title: "真实数据不足",
          summary: `${analysis.fund_code} 缺少真实核心数据，Argus 已阻止策略结论。`,
          priority: "high" as const,
          related_funds: [analysis.fund_code],
          is_mock: analysis.is_mock
        }))
      ],
      data_quality: homeDataQuality,
      generated_by: "Atlas",
      generated_at: portfolio.generated_at
    };
  }

  private homeRiskLevel(priorities: string[]): RiskLevel {
    if (priorities.includes("high")) return "high";
    if (priorities.includes("medium")) return "medium";
    return "low";
  }

  private homeQualityScore(portfolioScore: number, analyses: FundAnalysisResponse[]): number {
    const analysisScores = analyses.map((analysis) => analysis.data_pack.data_quality.score);
    const score = analysisScores.length ? Math.min(portfolioScore, ...analysisScores) : portfolioScore;
    return Number(Math.max(0, Math.min(1, score)).toFixed(2));
  }

  private dataQualityLevel(score: number): HomeDashboardResponse["data_quality"]["level"] {
    if (score >= 0.7) return "high";
    if (score >= 0.45) return "medium";
    return "low";
  }

  private analysisQualityWarnings(analyses: FundAnalysisResponse[]): string[] {
    return [
      ...new Set(
        analyses.flatMap((analysis) => {
          const quality = analysis.data_pack.data_quality_report;
          const warnings: string[] = [];
          if (analysis.data_pack.allow_downstream_analysis && !analysis.data_pack.allow_strong_conclusion) {
            const missing = [...quality.missing_core_fields, ...quality.missing_auxiliary_fields];
            warnings.push(
              `${analysis.fund_code} 已降级为观察/复核：data_status=${analysis.data_pack.data_status}，Argus 未允许强结论${
                missing.length ? `，缺口=${missing.slice(0, 5).join(", ")}` : ""
              }。`
            );
          }
          if (quality.stale_sources.length) {
            warnings.push(`${analysis.fund_code} 存在 stale 数据源：${quality.stale_sources.join(", ")}；首页必须保持降级展示。`);
          }
          if (quality.nav_consistency_report.status === "conflict") {
            warnings.push(`${analysis.fund_code} 存在 NAV 跨源冲突；首页仅展示复核任务，不形成策略动作。`);
          }
          return warnings;
        })
      )
    ];
  }

  private degradedAnalysisFocus(analyses: FundAnalysisResponse[]): TodayFocusItem[] {
    return analyses.slice(0, 3).map((analysis) => {
      const quality = analysis.data_pack.data_quality_report;
      const missing = [...new Set([...quality.missing_core_fields, ...quality.missing_auxiliary_fields])];
      return {
        title: "证据降级复核",
        summary: `${analysis.fund_code} 当前 data_status=${analysis.data_pack.data_status}，Argus 未允许强结论；${
          missing.length ? `优先修复 ${missing.slice(0, 4).join(", ")}。` : "优先复核数据新鲜度和一致性。"
        }`,
        priority: "high",
        related_funds: [analysis.fund_code],
        is_mock: analysis.is_mock || analysis.data_pack.is_mock
      };
    });
  }
}
