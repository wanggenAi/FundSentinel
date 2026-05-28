import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import { SourceRegistry } from "../dataSources/index.js";
import type { AgentInfo } from "../schemas/index.js";
import { AIGateway } from "./aiGateway.js";

export class AtlasOrchestrationService {
  constructor(
    private readonly sourceRegistry = new SourceRegistry(),
    private readonly aiGateway = new AIGateway()
  ) {}

  listAgents(): AgentInfo[] {
    return [
      new AtlasAgent(this.aiGateway).info(),
      new ArgusAgent(this.sourceRegistry, this.aiGateway).info(),
      new LogosAgent(this.aiGateway).info(),
      new NadirAgent(this.aiGateway).info(),
      new VegaAgent(this.aiGateway).info(),
      new AegisAgent(this.aiGateway).info()
    ];
  }
}
