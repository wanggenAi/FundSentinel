import type { PortfolioSnapshot } from "../schemas/index.js";
import { MockDataService } from "./mockDataService.js";

export class PortfolioService {
  constructor(private readonly mockDataService = new MockDataService()) {}

  getPortfolioSnapshot(userId = "mock-user"): PortfolioSnapshot {
    return this.mockDataService.getPortfolioSnapshot(userId);
  }
}

