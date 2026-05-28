import type { AgentResult } from "./agent.js";
import type { DataQuality, DataStatus } from "./common.js";
import type { DataAcquisitionPlan, DataAcquisitionSolution, DataGapReport, DataQualityReport, FundReportDocument, MacroIndicator } from "./data.js";
import type { FinalDecision } from "./decision.js";

export interface FundDataPack {
  fund_code: string;
  fund_name: string;
  fund_type: string;
  themes: string[];
  current_nav: number;
  daily_return: number;
  nav_history: number[];
  stage_returns: Record<string, number>;
  portfolio_holdings: string[];
  fund_report_refs: string[];
  fund_report_documents: FundReportDocument[];
  policy_signals: string[];
  macro_indicators: MacroIndicator[];
  news_summaries: string[];
  social_sentiment_score: number;
  evidence_items: AgentResult["evidence"];
  data_sources: Array<Record<string, unknown>>;
  data_acquisition_plan: DataAcquisitionPlan;
  data_quality_report: DataQualityReport;
  data_gap_report: DataGapReport | null;
  acquisition_solutions: DataAcquisitionSolution[];
  data_status: DataStatus;
  allow_downstream_analysis: boolean;
  allow_strong_conclusion: boolean;
  data_quality: DataQuality;
  updated_at: string;
  generated_at: string;
  is_mock: boolean;
}

export interface FundAnalysisResponse {
  task_id: string;
  fund_code: string;
  fund_name: string;
  is_mock: boolean;
  data_pack: FundDataPack;
  agent_results: Record<string, AgentResult>;
  final_decision: FinalDecision;
  blackboard_snapshot: Record<string, unknown>;
  generated_at: string;
}
