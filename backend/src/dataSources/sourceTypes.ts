import type { DataStatus, FundReportDocument, MacroIndicator } from "../schemas/index.js";

export type DataSourceType =
  | "fund_meta"
  | "current_nav"
  | "nav_history"
  | "holdings"
  | "fund_report"
  | "regulatory_disclosure"
  | "fund_company"
  | "index_data"
  | "macro_data"
  | "market_data"
  | "policy"
  | "news"
  | "social"
  | "manual_import"
  | "demo_fixture";

export type Freshness = "fresh" | "acceptable" | "stale" | "unknown";
export type ProviderTrustLevel = "A" | "B" | "C" | "D" | "E" | "DEMO";

export interface DataSourceInfo {
  source_id: string;
  source_name: string;
  source_type: DataSourceType;
  trust_level: ProviderTrustLevel;
  enabled: boolean;
  priority: number;
  access_method: string;
  requires_auth: boolean;
  is_demo: boolean;
  last_success_at: string | null;
  last_failed_at: string | null;
  failure_count: number;
  consecutive_failure_count: number;
  last_latency_ms: number | null;
  last_attempt_count: number;
  cache_hit_count: number;
  last_cache_hit_at: string | null;
  circuit_open_until: string | null;
  circuit_open_count: number;
  freshness_policy: string;
  notes: string;
}

export interface DataSourceCatalogEntry {
  source_id: string;
  source_name: string;
  source_type: DataSourceType;
  quality_tier: "authoritative" | "high" | "medium" | "low" | "demo";
  stability: "high" | "medium" | "low" | "unknown";
  coverage: string[];
  recommended_for: string[];
  access_method: string;
  requires_auth: boolean;
  is_demo: boolean;
  integration_status: "implemented" | "planned" | "requires_license" | "manual" | "blocked";
  legal_note: string;
  priority: number;
  notes: string;
}

export interface DataProviderResult<TOutput> {
  source_id: string;
  source_name: string;
  source_type: DataSourceType;
  trust_level: ProviderTrustLevel;
  data_status: DataStatus;
  success: boolean;
  data: TOutput | null;
  raw_reference: string | null;
  fetched_at: string;
  freshness: Freshness;
  warnings: string[];
  error: string | null;
  is_demo: boolean;
  attempt_count?: number;
  latency_ms?: number;
  cache_hit?: boolean;
  cache_expires_at?: string | null;
  skipped_by_circuit_breaker?: boolean;
}

export interface FundDataSourceInput {
  fund_code: string;
  required_data: string[];
  demo_mode: boolean;
  context?: ProviderFundPayload;
}

export interface ProviderFundPayload {
  fund_code?: string;
  fund_name?: string;
  fund_type?: string;
  current_nav?: number;
  daily_return?: number;
  nav_history?: number[];
  nav_history_dates?: string[];
  stage_returns?: Record<string, number>;
  portfolio_holdings?: string[];
  holdings_as_of?: string;
  holdings_source?: string;
  fund_report_refs?: string[];
  fund_report_documents?: FundReportDocument[];
  themes?: string[];
  policy_signals?: string[];
  news_summaries?: string[];
  social_sentiment_score?: number;
  manual_import_audit?: ManualImportAudit;
  manual_report_import_audit?: ManualReportImportAudit;
  macro_indicators?: MacroIndicator[];
}

export interface ManualImportAudit {
  file_path: string;
  file_sha256: string;
  file_size_bytes: number;
  file_mtime: string;
  row_count: number;
  date_start: string;
  date_end: string;
  latest_date: string;
  imported_at: string;
}

export interface ManualReportImportAudit {
  manifest_path: string;
  manifest_sha256: string;
  manifest_size_bytes: number;
  manifest_mtime: string;
  report_count: number;
  verified_pdf_count: number;
  latest_report_date: string;
  imported_at: string;
  reports: Array<{
    announcement_id: string;
    source_url: string;
    pdf_path: string;
    pdf_sha256: string;
    pdf_size_bytes: number;
    pdf_mtime: string;
  }>;
}
