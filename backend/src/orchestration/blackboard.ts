import type { AgentResult, FundDataPack } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";

interface TaskState {
  task_id: string;
  fund_code: string;
  status: "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  data_pack: FundDataPack | null;
  agent_results: Record<string, AgentResult>;
  degraded: boolean;
  degrade_reasons: string[];
  failed: boolean;
  failure_reason: string | null;
}

export class SharedBlackboard {
  private readonly tasks = new Map<string, TaskState>();

  createTask(taskId: string, fundCode: string): TaskState {
    const now = nowIso();
    const task: TaskState = {
      task_id: taskId,
      fund_code: fundCode,
      status: "running",
      created_at: now,
      updated_at: now,
      data_pack: null,
      agent_results: {},
      degraded: false,
      degrade_reasons: [],
      failed: false,
      failure_reason: null
    };
    this.tasks.set(taskId, task);
    return task;
  }

  writeArgusDataPack(taskId: string, dataPack: FundDataPack): void {
    const task = this.requireTask(taskId);
    task.data_pack = dataPack;
    task.updated_at = nowIso();
  }

  writeAgentResult(taskId: string, result: AgentResult): void {
    const task = this.requireTask(taskId);
    task.agent_results[result.agent_name] = result;
    task.updated_at = nowIso();
  }

  getAgentResult(taskId: string, agentName: string): AgentResult | undefined {
    return this.requireTask(taskId).agent_results[agentName];
  }

  getAllAgentResults(taskId: string): Record<string, AgentResult> {
    return { ...this.requireTask(taskId).agent_results };
  }

  getDataPack(taskId: string): FundDataPack | null {
    return this.requireTask(taskId).data_pack;
  }

  dependenciesCompleted(taskId: string, dependencies: string[]): boolean {
    const results = this.requireTask(taskId).agent_results;
    return dependencies.every((name) => results[name]);
  }

  markDegraded(taskId: string, reason: string): void {
    const task = this.requireTask(taskId);
    task.degraded = true;
    task.degrade_reasons.push(reason);
    task.updated_at = nowIso();
  }

  markFailed(taskId: string, reason: string): void {
    const task = this.requireTask(taskId);
    task.failed = true;
    task.status = "failed";
    task.failure_reason = reason;
    task.updated_at = nowIso();
  }

  markCompleted(taskId: string): void {
    const task = this.requireTask(taskId);
    task.status = "completed";
    task.updated_at = nowIso();
  }

  exportSnapshot(taskId: string): Record<string, unknown> {
    const task = this.requireTask(taskId);
    return structuredClone(task) as unknown as Record<string, unknown>;
  }

  private requireTask(taskId: string): TaskState {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}

