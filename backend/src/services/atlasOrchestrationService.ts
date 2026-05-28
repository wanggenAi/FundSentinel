import { AegisAgent, ArgusAgent, AtlasAgent, LogosAgent, NadirAgent, VegaAgent } from "../agents/index.js";
import type { AgentInfo } from "../schemas/index.js";
import { AIGateway } from "./aiGateway.js";
import { MockDataService } from "./mockDataService.js";

export class AtlasOrchestrationService {
  constructor(
    private readonly mockDataService = new MockDataService(),
    private readonly aiGateway = new AIGateway()
  ) {}

  listAgents(): AgentInfo[] {
    return [
      new AtlasAgent(this.aiGateway).info(),
      new ArgusAgent(this.mockDataService, this.aiGateway).info(),
      new LogosAgent(this.aiGateway).info(),
      new NadirAgent(this.aiGateway).info(),
      new VegaAgent(this.aiGateway).info(),
      new AegisAgent(this.aiGateway).info()
    ];
  }
}

