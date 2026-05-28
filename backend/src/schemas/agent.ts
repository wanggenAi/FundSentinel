import type { AgentStatus, SourceType, TrustLevel } from "./common.js";

export interface EvidenceItem {
  title: string;
  source_name: string;
  source_type: SourceType;
  trust_level: TrustLevel;
  summary: string;
  importance_score: number;
  related_theme: string | null;
  published_at: string | null;
  url: string | null;
  is_mock: boolean;
}

export interface AgentResult {
  agent_name: string;
  agent_role: string;
  agent_version: string;
  task_id: string;
  fund_code: string | null;
  status: AgentStatus;
  score: number | null;
  confidence: number;
  summary: string;
  evidence: EvidenceItem[];
  metrics: Record<string, unknown>;
  warnings: string[];
  next_suggestions: string[];
  created_at: string;
  is_mock: boolean;
}

export interface AgentInfo {
  name: string;
  role: string;
  version: string;
  responsibilities: string[];
}

export interface AnalyzeRequest {
  fund_code: string;
  user_request: string;
}

