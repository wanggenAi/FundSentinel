export type AgentStatus = "success" | "warning" | "failed";
export type SourceType = "policy" | "fund_report" | "official" | "industry_data" | "news" | "social" | "mock";
export type TrustLevel = "A" | "B" | "C" | "D" | "E";
export type RiskLevel = "low" | "medium" | "high";
export type DataQualityLevel = "high" | "medium" | "low";
export type StrategyAction = "avoid" | "observe" | "trial_buy" | "staged_buy" | "hold" | "reduce" | "exit";
export type TriggerType = "observe" | "trial_buy" | "add_position" | "reduce" | "exit" | "risk_warning";
export type TriggerPriority = "low" | "medium" | "high";
export type TrendStatus = "falling" | "stabilizing" | "improving" | "weakening";

export interface DataQuality {
  level: DataQualityLevel;
  score: number;
  source: string;
  updated_at: string;
  warnings: string[];
  is_mock: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

