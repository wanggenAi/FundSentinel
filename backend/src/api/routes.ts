import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AtlasOrchestrationService, DataSourceService, FundAnalysisService, HomeService, OpportunityService } from "../services/index.js";
import { nowIso } from "../schemas/index.js";

const analyzeRequestSchema = z.object({
  fund_code: z.string().min(1),
  user_request: z.string().min(1)
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    service: "FundSentinel AI backend",
    version: "0.1.0",
    runtime: "typescript-fastify",
    is_mock: true,
    generated_at: nowIso()
  }));

  app.get("/api/agents", async () => new AtlasOrchestrationService().listPublicAgents());

  app.get("/api/data-sources", async () => new DataSourceService().listSources());

  app.get("/api/data-sources/catalog", async () => new DataSourceService().catalog());

  app.get("/api/data-sources/coverage", async () => new DataSourceService().coverage());

  app.get("/api/data-sources/health", async () => new DataSourceService().health());

  app.get<{ Params: { fund_code: string } }>("/api/data-sources/gaps/:fund_code", async (request) =>
    new DataSourceService().gaps(request.params.fund_code)
  );

  app.post("/api/data-sources/manual-import/plan", async () => new DataSourceService().manualImportPlan());

  app.get("/api/home", async () => new HomeService().getHomeDashboard());

  app.get<{ Querystring: { limit?: string | number } }>("/api/opportunities", async (request) => {
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 6 : Number(rawLimit);
    return new OpportunityService().getOpportunities(Number.isFinite(limit) ? limit : 6);
  });

  app.get<{ Params: { fund_code: string } }>("/api/funds/:fund_code/analysis", async (request) =>
    new FundAnalysisService().analyzeFundPublic(request.params.fund_code)
  );

  app.post("/api/analyze", async (request, reply) => {
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
        is_mock: true
      });
    }
    return new FundAnalysisService().analyzeFundPublic(parsed.data.fund_code);
  });
}
