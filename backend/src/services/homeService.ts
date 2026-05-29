import type { HomeDashboardResponse, RiskLevel } from "../schemas/index.js";
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
      is_mock: portfolio.is_mock,
      total_assets: portfolio.total_assets,
      daily_pnl: portfolio.daily_pnl,
      daily_pnl_ratio: portfolio.daily_pnl_ratio,
      holding_count: portfolio.holdings.length,
      risk_level: this.homeRiskLevel(strategyTriggers.map((trigger) => trigger.priority)),
      strategy_triggers: strategyTriggers,
      holding_alerts: this.strategyTriggerService.buildHoldingAlerts(actionableAnalyses),
      today_focus: [
        ...portfolioGapFocus,
        ...this.strategyTriggerService.buildTodayFocus(strategyTriggers),
        ...blockedFunds.slice(0, 3).map((analysis) => ({
          title: "真实数据不足",
          summary: `${analysis.fund_code} 缺少真实核心数据，Argus 已阻止策略结论。`,
          priority: "high" as const,
          related_funds: [analysis.fund_code],
          is_mock: analysis.is_mock
        }))
      ],
      data_quality: portfolio.data_quality,
      generated_by: "Atlas",
      generated_at: portfolio.generated_at
    };
  }

  private homeRiskLevel(priorities: string[]): RiskLevel {
    if (priorities.includes("high")) return "high";
    if (priorities.includes("medium")) return "medium";
    return "low";
  }
}
