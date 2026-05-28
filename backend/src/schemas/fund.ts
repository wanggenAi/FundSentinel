import type { AgentResult } from "./agent.js";
import type { DataQuality } from "./common.js";
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
  policy_signals: string[];
  news_summaries: string[];
  social_sentiment_score: number;
  data_quality: DataQuality;
  updated_at: string;
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

