export interface AIRequest {
  agentName: string;
  taskId: string;
  fundCode?: string;
  prompt: string;
  context: Record<string, unknown>;
}

export interface AIResponse {
  available: boolean;
  content: string;
  model?: string;
  error?: string;
  is_mock: boolean;
}

export class AIGateway {
  private readonly enabled: boolean;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model?: string;
  private readonly timeoutMs: number;

  constructor(options: { enabled?: boolean; apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number } = {}) {
    this.enabled =
      options.enabled ??
      ["1", "true", "yes", "on"].includes((process.env.FUNDSENTINEL_AI_ENABLED ?? "false").toLowerCase());
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? process.env.OPENAI_MODEL ?? process.env.FUNDSENTINEL_AI_MODEL;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  get available(): boolean {
    return Boolean(this.enabled && this.apiKey && this.model);
  }

  async complete(request: AIRequest): Promise<AIResponse> {
    if (!this.available) {
      return {
        available: false,
        content: "",
        model: this.model,
        error: "AI gateway disabled or missing OPENAI_API_KEY/OPENAI_MODEL.",
        is_mock: true
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content:
                "You are a FundSentinel backend analysis agent. Return conservative, traceable analysis. Never promise returns, never execute trades, and clearly state uncertainty."
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  agent_name: request.agentName,
                  task_id: request.taskId,
                  fund_code: request.fundCode,
                  prompt: request.prompt,
                  context: request.context
                },
                null,
                2
              )
            }
          ]
        })
      });
      if (!response.ok) {
        return {
          available: false,
          content: "",
          model: this.model,
          error: `AI gateway HTTP ${response.status}`,
          is_mock: false
        };
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        available: true,
        content: body.choices?.[0]?.message?.content ?? "",
        model: this.model,
        is_mock: false
      };
    } catch (error) {
      return {
        available: false,
        content: "",
        model: this.model,
        error: error instanceof Error ? error.message : String(error),
        is_mock: false
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

