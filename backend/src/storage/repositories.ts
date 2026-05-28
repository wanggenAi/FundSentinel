export class AnalysisSnapshotRepository {
  private readonly snapshots = new Map<string, Record<string, unknown>>();

  saveSnapshot(taskId: string, snapshot: Record<string, unknown>): void {
    this.snapshots.set(taskId, structuredClone(snapshot));
  }

  getSnapshot(taskId: string): Record<string, unknown> | undefined {
    const snapshot = this.snapshots.get(taskId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
}

