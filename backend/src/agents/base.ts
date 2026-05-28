import type { AgentInfo, AgentResult, EvidenceItem } from "../schemas/index.js";
import { nowIso, type AgentStatus } from "../schemas/index.js";
import { AIGateway, type AIResponse } from "../services/aiGateway.js";

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly role: string;
  readonly version = "0.1.0";
  abstract readonly responsibilities: string[];

  constructor(protected readonly aiGateway = new AIGateway({ enabled: false })) {}

  info(): AgentInfo {
    return {
      name: this.name,
      role: this.role,
      version: this.version,
      responsibilities: this.responsibilities
    };
  }

  protected buildResult(input: {
    taskId: string;
    fundCode: string | null;
    status: AgentStatus;
    score: number | null;
    confidence: number;
    summary: string;
    evidence?: EvidenceItem[];
    metrics?: Record<string, unknown>;
    warnings?: string[];
    nextSuggestions?: string[];
    isMock?: boolean;
  }): AgentResult {
    return {
      agent_name: this.name,
      agent_role: this.role,
      agent_version: this.version,
      task_id: input.taskId,
      fund_code: input.fundCode,
      status: input.status,
      score: input.score,
      confidence: input.confidence,
      summary: input.summary,
      evidence: input.evidence ?? [],
      metrics: input.metrics ?? {},
      warnings: input.warnings ?? [],
      next_suggestions: input.nextSuggestions ?? [],
      created_at: nowIso(),
      is_mock: input.isMock ?? true
    };
  }

  protected async askAI(input: {
    taskId: string;
    fundCode?: string;
    prompt: string;
    context: Record<string, unknown>;
  }): Promise<AIResponse> {
    return this.aiGateway.complete({
      agentName: this.name,
      taskId: input.taskId,
      fundCode: input.fundCode,
      prompt: input.prompt,
      context: input.context
    });
  }
}
