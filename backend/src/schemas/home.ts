import type { DataQuality, RiskLevel } from "./common.js";
import type { ManualPortfolioImportAudit } from "./portfolio.js";
import type { HoldingAlert, StrategyTrigger, TodayFocusItem } from "./strategy.js";

export interface HomeDashboardResponse {
  is_mock: boolean;
  total_assets: number;
  daily_pnl: number;
  daily_pnl_ratio: number;
  holding_count: number;
  risk_level: RiskLevel;
  strategy_triggers: StrategyTrigger[];
  holding_alerts: HoldingAlert[];
  today_focus: TodayFocusItem[];
  data_quality: DataQuality;
  manual_import_audit?: ManualPortfolioImportAudit;
  generated_by: "Atlas";
  generated_at: string;
}
