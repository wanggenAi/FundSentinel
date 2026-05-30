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

export interface OpportunityUniverseAudit {
  source_type: "configured_env" | "configured_options" | "demo_fixture" | "unconfigured";
  source_name: string;
  configured_count: number;
  selected_count: number;
  requested_limit: number;
  selected_fund_codes: string[];
  ignored_invalid_fund_codes: string[];
  is_mock: boolean;
}

export interface OpportunitySquareResponse {
  is_mock: boolean;
  candidates: OpportunityCandidate[];
  summary: string;
  data_quality: DataQuality;
  universe_audit: OpportunityUniverseAudit;
  generated_by: "Atlas";
  generated_at: string;
}
