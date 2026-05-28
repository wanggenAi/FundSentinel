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
    const strategyTriggers = this.strategyTriggerService.buildTriggers(analyses);
    return {
      is_mock: true,
      total_assets: portfolio.total_assets,
      daily_pnl: portfolio.daily_pnl,
      daily_pnl_ratio: portfolio.daily_pnl_ratio,
      holding_count: portfolio.holdings.length,
      risk_level: this.homeRiskLevel(strategyTriggers.map((trigger) => trigger.priority)),
      strategy_triggers: strategyTriggers,
      holding_alerts: this.strategyTriggerService.buildHoldingAlerts(analyses),
      today_focus: this.strategyTriggerService.buildTodayFocus(strategyTriggers),
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

