import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AtlasOrchestrationService, DataSourceService, FundAnalysisService, HomeService, OpportunityService } from "../services/index.js";
import { nowIso } from "../schemas/index.js";

const fundIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?:\d{1,10}|CIK\d{1,10}|[A-Za-z][A-Za-z0-9.-]{0,9})$/u, "Fund identifier must be a fund code, SEC CIK, or ticker-like symbol.");

const analyzeRequestSchema = z.object({
  fund_code: fundIdentifierSchema,
  user_request: z.string().trim().min(1)
});

function taskIdForAnalyzeRequest(fundCode: string, userRequest: string): string {
  const requestHash = createHash("sha256").update(userRequest.trim()).digest("hex").slice(0, 12);
  return `api-analyze-${fundCode}-${requestHash}`;
}

function parseFundIdentifier(fundCode: string, reply: FastifyReply) {
  const parsed = fundIdentifierSchema.safeParse(fundCode);
  if (!parsed.success) {
    reply.code(400).send({
      error: "Invalid fund identifier parameter",
      details: parsed.error.flatten(),
      is_mock: false
    });
    return null;
  }
  return parsed.data;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    service: "FundSentinel AI backend",
    version: "0.1.0",
    runtime: "typescript-fastify",
    is_mock: false,
    generated_at: nowIso()
  }));

  app.get("/api/agents", async () => new AtlasOrchestrationService().listPublicAgents());

  app.get("/api/data-sources", async () => new DataSourceService().listSources());

  app.get("/api/data-sources/catalog", async () => new DataSourceService().catalog());

  app.get("/api/data-sources/coverage", async () => new DataSourceService().coverage());

  app.get("/api/data-sources/health", async () => new DataSourceService().health());

  app.get<{ Params: { fund_code: string } }>("/api/data-sources/gaps/:fund_code", async (request, reply) => {
    const fundCode = parseFundIdentifier(request.params.fund_code, reply);
    if (!fundCode) return;
    return new DataSourceService().gaps(fundCode);
  });

  app.post("/api/data-sources/manual-import/plan", async () => new DataSourceService().manualImportPlan());

  app.get("/api/home", async () => new HomeService().getHomeDashboard());

  app.get<{ Querystring: { limit?: string | number } }>("/api/opportunities", async (request, reply) => {
    const rawLimit = request.query.limit;
    const limit = rawLimit === undefined ? 6 : Number(rawLimit);
    if (!Number.isFinite(limit)) {
      return reply.code(400).send({
        error: "Invalid opportunities limit query parameter",
        details: {
          limit: ["Limit must be a finite number."]
        },
        is_mock: false
      });
    }
    return new OpportunityService().getOpportunities(limit);
  });

  app.get<{ Params: { fund_code: string } }>("/api/funds/:fund_code/analysis", async (request, reply) => {
    const fundCode = parseFundIdentifier(request.params.fund_code, reply);
    if (!fundCode) return;
    return new FundAnalysisService().analyzeFundPublic(fundCode);
  });

  app.post("/api/analyze", async (request, reply) => {
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request body",
        details: parsed.error.flatten(),
        is_mock: false
      });
    }
    return new FundAnalysisService().analyzeFundPublic(parsed.data.fund_code, taskIdForAnalyzeRequest(parsed.data.fund_code, parsed.data.user_request));
  });
}
