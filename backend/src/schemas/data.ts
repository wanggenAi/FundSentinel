import type { DataRequirement, DataStatus, DataQualityLevel } from "./common.js";

export interface ProviderCandidate {
  source_id: string;
  source_name: string;
  source_type: string;
  priority: number;
  is_demo: boolean;
  enabled: boolean;
}

export interface DataAcquisitionPlan {
  task_id: string;
  fund_code: string;
  requested_by: "Atlas";
  required_data: DataRequirement[];
  optional_data: DataRequirement[];
  provider_candidates: ProviderCandidate[];
  acquisition_strategy: string;
  fallback_strategy: string;
  created_by: "Argus";
  created_at: string;
}

export interface DataQualityReport {
  data_status: DataStatus;
  level: DataQualityLevel;
  score: number;
  real_source_count: number;
  demo_source_count: number;
  successful_source_count: number;
  failed_source_count: number;
  missing_core_fields: string[];
  missing_auxiliary_fields: string[];
  stale_sources: string[];
  warnings: string[];
  blocking_issues: string[];
  allow_downstream_analysis: boolean;
  allow_strong_conclusion: boolean;
  generated_by: "Argus";
  generated_at: string;
}

export interface DataGapReport {
  fund_code: string;
  missing_data: string[];
  failed_sources: string[];
  impact: string;
  blocking_downstream_agents: string[];
  recommended_solutions: string[];
  created_by: "Argus";
  created_at: string;
}

export interface DataAcquisitionSolution {
  problem: string;
  severity: "low" | "medium" | "high" | "blocking";
  proposed_actions: string[];
  engineering_tasks: string[];
  manual_workaround: string[];
  owner_agent: "Argus";
}

export interface FundReportDocument {
  title: string;
  announcement_id: string;
  published_at: string | null;
  category: string | null;
  document_kind: "periodic_report" | "report_notice" | "business_notice" | "sales_document" | "other";
  detail_url: string | null;
  pdf_url: string | null;
  pdf_verified: boolean;
  pdf_content_type: string | null;
  pdf_content_length: number | null;
  source_name: string;
  source_type: "aggregator_index" | "official_disclosure" | "manual_import";
  trust_level: "A" | "B" | "C" | "D" | "E" | "DEMO";
}

export interface MacroIndicator {
  country_code: string;
  country_name: string;
  indicator_id: string;
  indicator_name: string;
  value: number;
  date: string;
  unit: string | null;
  source_url: string;
  source_name: string;
  fetched_at: string;
}
