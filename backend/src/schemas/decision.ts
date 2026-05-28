import type { RiskLevel, StrategyAction } from "./common.js";

export interface FinalDecision {
  action: StrategyAction;
  confidence: number;
  risk_level: RiskLevel;
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

