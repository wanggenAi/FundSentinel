import type { EvidenceItem } from "./agent.js";
import type { DataQuality, StrategyAction } from "./common.js";

export interface OpportunityCandidate {
  fund_code: string;
  fund_name: string;
  fund_type: string;
  themes: string[];
  current_nav: number;
  daily_return: number;
  hard_logic_score: number;
  low_position_score: number;
  turning_point_score: number;
  risk_position_score: number;
  overall_opportunity_score: number;
  action: StrategyAction;
  confidence: number;
  reason_summary: string;
  risk_summary: string;
  key_evidence: EvidenceItem[];
  is_mock: boolean;
}

export interface OpportunitySquareResponse {
  is_mock: boolean;
  candidates: OpportunityCandidate[];
  summary: string;
  data_quality: DataQuality;
  generated_by: "Atlas";
  generated_at: string;
}

