export class InMemoryTaskBus {
  private readonly events = new Map<string, Array<Record<string, unknown>>>();

  publish(taskId: string, event: Record<string, unknown>): void {
    const current = this.events.get(taskId) ?? [];
    current.push(event);
    this.events.set(taskId, current);
  }

  drain(taskId: string): Array<Record<string, unknown>> {
    const current = this.events.get(taskId) ?? [];
    this.events.set(taskId, []);
    return current;
  }
}

