import type { EvidenceItem } from "./agent.js";
import type { DataQuality } from "./common.js";

export type OpportunityReviewStatus = "observe" | "evidence_review" | "risk_review" | "data_gap_review";

export interface OpportunityCandidate {
  fund_code: string;
  fund_name: string;
  fund_type: string;
  themes: string[];
  current_nav: number;
  daily_return: number;
  hard_logic_score: number;
  low_nav_score: number;
  turning_point_score: number;
  risk_review_score: number;
  overall_opportunity_score: number;
  review_status: OpportunityReviewStatus;
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
