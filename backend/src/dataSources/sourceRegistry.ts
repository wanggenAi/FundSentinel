import { createHash } from "node:crypto";
import { AmacPublicFundDataProvider } from "./providers/amacPublicFundDataProvider.js";
import { ChinaAmcOfficialProvider } from "./providers/chinaAmcOfficialProvider.js";
import { CninfoReportProvider } from "./providers/cninfoReportProvider.js";
import { CmfChinaFundOfficialProvider } from "./providers/cmfChinaFundOfficialProvider.js";
import { CsrcFundDisclosureProvider } from "./providers/csrcFundDisclosureProvider.js";
import { CsrcOfficialProvider } from "./providers/csrcOfficialProvider.js";
import { CsrcPublicFundProductProvider } from "./providers/csrcPublicFundProductProvider.js";
import { DemoFixtureProvider } from "./providers/demoFixtureProvider.js";
import { EFundOfficialProvider } from "./providers/eFundOfficialProvider.js";
import { EastMoneyFundAnnouncementProvider } from "./providers/eastMoneyFundAnnouncementProvider.js";
import { EastMoneyFundArchiveProvider } from "./providers/eastMoneyFundArchiveProvider.js";
import { EastMoneyFundProvider } from "./providers/eastMoneyFundProvider.js";
import { EastMoneyNavHistoryProvider } from "./providers/eastMoneyNavHistoryProvider.js";
import { EurostatProvider } from "./providers/eurostatProvider.js";
import { FredMacroProvider } from "./providers/fredMacroProvider.js";
import { FullgoalFundOfficialProvider } from "./providers/fullgoalFundOfficialProvider.js";
import { FundCompanyReportProvider } from "./providers/fundCompanyReportProvider.js";
import { GovCnPolicyProvider } from "./providers/govCnPolicyProvider.js";
import { HarvestFundOfficialProvider } from "./providers/harvestFundOfficialProvider.js";
import { HkexOfficialProvider } from "./providers/hkexOfficialProvider.js";
import { HuaAnFundOfficialProvider } from "./providers/huaAnFundOfficialProvider.js";
import { ImfDataMapperProvider } from "./providers/imfDataMapperProvider.js";
import { ManualCsvProvider } from "./providers/manualCsvProvider.js";
import { ManualOfficialReportProvider } from "./providers/manualOfficialReportProvider.js";
import { MiitOfficialProvider } from "./providers/miitOfficialProvider.js";
import { MofFiscalProvider } from "./providers/mofFiscalProvider.js";
import { OecdCliProvider } from "./providers/oecdCliProvider.js";
import { PbcMacroProvider } from "./providers/pbcMacroProvider.js";
import { NdrcOfficialProvider } from "./providers/policyNewsProvider.js";
import { SafeMacroProvider } from "./providers/safeMacroProvider.js";
import { SecEdgarProvider } from "./providers/secEdgarProvider.js";
import { StatsGovMacroProvider } from "./providers/statsGovMacroProvider.js";
import { SseMarketCalendarProvider } from "./providers/sseMarketCalendarProvider.js";
import { WorldBankMacroProvider } from "./providers/worldBankMacroProvider.js";
import type { DataProvider } from "./providers/baseProvider.js";
import type { DataProviderResult, DataSourceCatalogEntry, DataSourceInfo, DataSourceType, FundDataSourceInput, ProviderFundPayload } from "./sourceTypes.js";
import { listDataSourceCatalog } from "./sourceCatalog.js";
import { validFundReportDocuments } from "./fundReportDocumentValidation.js";
import { nowIso, type DataStatus } from "../schemas/index.js";
import type { DataRequirement } from "../schemas/index.js";
import { sanitizePublicStructure, sanitizePublicText } from "../utils/publicText.js";

export interface SourceRegistryOptions {
  demoMode?: boolean;
  enableLiveProviders?: boolean;
  cacheTtlMs?: number;
  retryCount?: number;
  failureCooldownMs?: number;
  failureThreshold?: number;
  shareState?: boolean;
  providers?: Array<DataProvider<FundDataSourceInput, ProviderFundPayload>>;
}

interface CachedProviderResult {
  sourceId: string;
  result: DataProviderResult<ProviderFundPayload>;
  expiresAt: number;
}

interface SharedRegistryState {
  sourceStates: Map<string, DataSourceInfo>;
  resultCache: Map<string, CachedProviderResult>;
}

const defaultSharedState: SharedRegistryState = {
  sourceStates: new Map<string, DataSourceInfo>(),
  resultCache: new Map<string, CachedProviderResult>()
};

const COORDINATOR_SOURCE_IDS = new Set(["fund-company-report"]);
const FUND_CORE_CONTEXT_SOURCE_TYPES = new Set<DataSourceType>([
  "fund_meta",
  "current_nav",
  "nav_history",
  "holdings",
  "fund_report",
  "regulatory_disclosure",
  "fund_company",
  "manual_import"
]);
type CoverageRequirement = DataRequirement | "official_current_nav" | "official_nav_history" | "official_fund_reports" | "benchmark";
type ContextCoreField = "fund_code" | "fund_name" | "fund_type" | "current_nav" | "daily_return";
const DATA_STATUSES = new Set<DataStatus>(["ready", "partial", "insufficient", "unavailable", "demo"]);
const FRESHNESS_VALUES = new Set(["fresh", "acceptable", "stale", "unknown"]);

interface ContextMergeState {
  coreFieldPriorities: Partial<Record<ContextCoreField, number>>;
  stageReturnPriorities: Record<string, number>;
  navHistoryPriority: number;
  holdingsPriority: number;
}

export class SourceRegistry {
  private readonly providers: Array<DataProvider<FundDataSourceInput, ProviderFundPayload>>;
  private readonly sourceStates: Map<string, DataSourceInfo>;
  private readonly demoMode: boolean;
  private readonly enableLiveProviders: boolean;
  private readonly usesCustomProviders: boolean;
  private readonly cacheTtlMs: number;
  private readonly retryCount: number;
  private readonly failureCooldownMs: number;
  private readonly failureThreshold: number;
  private readonly resultCache: Map<string, CachedProviderResult>;
  private readonly sharedState: SharedRegistryState;

  constructor(options: boolean | SourceRegistryOptions = {}) {
    const normalized: SourceRegistryOptions = typeof options === "boolean" ? { demoMode: options } : options;
    this.demoMode = normalized.demoMode ?? process.env.FUNDSENTINEL_DEMO_MODE === "true";
    this.enableLiveProviders =
      normalized.enableLiveProviders ?? (process.env.FUNDSENTINEL_DISABLE_LIVE_PROVIDERS !== "true" && process.env.NODE_ENV !== "test");
    this.usesCustomProviders = Boolean(normalized.providers);
    this.cacheTtlMs = normalized.cacheTtlMs ?? Number(process.env.FUNDSENTINEL_PROVIDER_CACHE_TTL_MS ?? 300_000);
    this.retryCount = normalized.retryCount ?? Number(process.env.FUNDSENTINEL_PROVIDER_RETRY_COUNT ?? 1);
    this.failureCooldownMs = normalized.failureCooldownMs ?? Number(process.env.FUNDSENTINEL_PROVIDER_FAILURE_COOLDOWN_MS ?? 120_000);
    this.failureThreshold = normalized.failureThreshold ?? Number(process.env.FUNDSENTINEL_PROVIDER_FAILURE_THRESHOLD ?? 2);
    this.sharedState =
      normalized.shareState ?? !this.usesCustomProviders
        ? defaultSharedState
        : { sourceStates: new Map<string, DataSourceInfo>(), resultCache: new Map<string, CachedProviderResult>() };
    this.sourceStates = this.sharedState.sourceStates;
    this.resultCache = this.sharedState.resultCache;
    this.providers = normalized.providers ?? [
      new CsrcFundDisclosureProvider(),
      new CsrcOfficialProvider(),
      new CsrcPublicFundProductProvider(),
      new AmacPublicFundDataProvider(),
      new EastMoneyFundProvider(),
      new EastMoneyNavHistoryProvider(),
      new EastMoneyFundArchiveProvider(),
      new EastMoneyFundAnnouncementProvider(),
      new CmfChinaFundOfficialProvider(),
      new HuaAnFundOfficialProvider(),
      new EFundOfficialProvider(),
      new ChinaAmcOfficialProvider(),
      new HarvestFundOfficialProvider(),
      new FullgoalFundOfficialProvider(),
      new CninfoReportProvider(),
      new GovCnPolicyProvider(),
      new MofFiscalProvider(),
      new SafeMacroProvider(),
      new PbcMacroProvider(),
      new StatsGovMacroProvider(),
      new SecEdgarProvider(),
      new FundCompanyReportProvider(),
      new HkexOfficialProvider(),
      new FredMacroProvider(),
      new WorldBankMacroProvider(),
      new ImfDataMapperProvider(),
      new OecdCliProvider(),
      new EurostatProvider(),
      new NdrcOfficialProvider(),
      new MiitOfficialProvider(),
      new SseMarketCalendarProvider(),
      new ManualOfficialReportProvider(),
      new ManualCsvProvider(),
      new DemoFixtureProvider()
    ];
    for (const provider of this.providers) {
      const info = provider.sourceInfo();
      this.sourceStates.set(info.source_id, this.initialSourceState(info, this.sourceStates.get(info.source_id)));
    }
  }

  listSources(): DataSourceInfo[] {
    return sanitizePublicStructure(this.rawListSources());
  }

  health(): Array<
    DataSourceInfo & { health_status: "healthy" | "disabled" | "failing" | "demo_only" | "cooldown"; cache_entries: number; cooldown_remaining_ms: number }
  > {
    return sanitizePublicStructure(this.rawListSources().map((source) => ({
      ...source,
      health_status: this.healthStatusFor(source),
      cache_entries: this.cacheEntryCountFor(source.source_id),
      cooldown_remaining_ms: this.cooldownRemainingMs(source)
    })));
  }

  catalog() {
    return sanitizePublicStructure(listDataSourceCatalog());
  }

  coverageMatrix(): Array<{
    requirement: CoverageRequirement;
    source_ids: string[];
    implemented_source_ids: string[];
    coordinator_source_ids: string[];
    manual_source_ids: string[];
    manual_workaround_source_ids: string[];
    authoritative_source_ids: string[];
    implemented_authoritative_source_ids: string[];
    planned_source_ids: string[];
    blocked_source_ids: string[];
    requires_license_source_ids: string[];
    needs_license_source_ids: string[];
    gap_level: "covered" | "partial" | "missing" | "requires_license";
    coverage_status: "covered" | "partial" | "missing" | "licensed_only";
    notes: string;
  }> {
    const catalog = listDataSourceCatalog();
    const requirements: CoverageRequirement[] = [
      "fund_meta",
      "current_nav",
      "official_current_nav",
      "nav_history",
      "official_nav_history",
      "holdings",
      "fund_reports",
      "official_fund_reports",
      "policy_evidence",
      "industry_news",
      "social_sentiment",
      "benchmark",
      "macro_data"
    ];

    return sanitizePublicStructure(requirements.map((requirement) => {
      const matching = catalog.filter(
        (source) =>
          source.recommended_for.includes(requirement) ||
          source.coverage.includes(requirement) ||
          (requirement === "official_current_nav" &&
            (source.recommended_for.includes("current_nav") || source.coverage.includes("current_nav")) &&
            source.quality_tier === "authoritative") ||
          (requirement === "official_nav_history" &&
            (source.recommended_for.includes("nav_history") || source.coverage.includes("nav_history")) &&
            source.quality_tier === "authoritative") ||
          (requirement === "macro_data" && (source.source_type === "macro_data" || source.recommended_for.includes("macro_context")))
      );
      const implemented = matching.filter(
        (source) =>
          source.integration_status === "implemented" &&
          !source.is_demo &&
          !COORDINATOR_SOURCE_IDS.has(source.source_id) &&
          source.source_type !== "manual_import" &&
          (requirement !== "macro_data" || source.source_type === "macro_data" || source.coverage.includes("macro_data"))
      );
      const coordinators = matching.filter((source) => source.integration_status === "implemented" && COORDINATOR_SOURCE_IDS.has(source.source_id));
      const manualSources = matching.filter((source) => source.source_type === "manual_import" && !source.is_demo);
      const manualWorkarounds = this.manualWorkaroundSourcesFor(requirement, catalog);
      const authoritative = matching.filter((source) => source.quality_tier === "authoritative");
      const implementedAuthoritative = implemented.filter((source) => source.quality_tier === "authoritative");
      const planned = matching.filter((source) => source.integration_status === "planned");
      const blocked = matching.filter((source) => source.integration_status === "blocked");
      const needsLicense = matching.filter((source) => source.integration_status === "requires_license");
      let gapLevel: "covered" | "partial" | "missing" | "requires_license" = "missing";
      if (requirement === "official_fund_reports" && implemented.length > 0) gapLevel = "partial";
      else if (implemented.some((source) => source.quality_tier === "authoritative")) gapLevel = "covered";
      else if (implemented.length > 0) gapLevel = "partial";
      else if (needsLicense.length > 0 && matching.length === needsLicense.length) gapLevel = "requires_license";

      return {
        requirement,
        source_ids: matching.map((source) => source.source_id),
        implemented_source_ids: implemented.map((source) => source.source_id),
        coordinator_source_ids: coordinators.map((source) => source.source_id),
        manual_source_ids: manualSources.map((source) => source.source_id),
        manual_workaround_source_ids: manualWorkarounds.map((source) => source.source_id),
        authoritative_source_ids: authoritative.map((source) => source.source_id),
        implemented_authoritative_source_ids: implementedAuthoritative.map((source) => source.source_id),
        planned_source_ids: planned.map((source) => source.source_id),
        blocked_source_ids: blocked.map((source) => source.source_id),
        requires_license_source_ids: needsLicense.map((source) => source.source_id),
        needs_license_source_ids: needsLicense.map((source) => source.source_id),
        gap_level: gapLevel,
        coverage_status: gapLevel === "requires_license" ? "licensed_only" : gapLevel,
        notes: this.coverageNoteFor(requirement, gapLevel)
      };
    }));
  }

  providerCandidates(): Array<{ source_id: string; source_name: string; source_type: string; priority: number; is_demo: boolean; enabled: boolean }> {
    return sanitizePublicStructure(this.rawListSources().map((source) => ({
      source_id: source.source_id,
      source_name: source.source_name,
      source_type: source.source_type,
      priority: source.priority,
      is_demo: source.is_demo,
      enabled: source.enabled
    })));
  }

  private rawListSources(): DataSourceInfo[] {
    return [...this.sourceStates.values()].sort((a, b) => a.priority - b.priority);
  }

  async fetchAll(input: FundDataSourceInput): Promise<Array<DataProviderResult<ProviderFundPayload>>> {
    const activeProviders = this.providers
      .filter((provider) => {
        const info = this.sourceStates.get(provider.sourceInfo().source_id)!;
        return info.enabled;
      })
      .sort((a, b) => this.sourceStates.get(a.sourceInfo().source_id)!.priority - this.sourceStates.get(b.sourceInfo().source_id)!.priority);

    const results: Array<DataProviderResult<ProviderFundPayload>> = [];
    let context: ProviderFundPayload = this.validatedContextPayload(input.context ?? {}, input.fund_code);
    const contextMergeState = this.initialContextMergeState(context);
    for (const provider of activeProviders) {
      const providerInput = { ...input, context, demo_mode: this.demoMode };
      if (!provider.canHandle(providerInput)) continue;
      const result = await this.fetchProvider(provider, providerInput);
      this.recordResult(result);
      results.push(result);
      if (result.success && result.data) context = this.mergeContextForResult(context, result, contextMergeState, input.fund_code);
    }
    return results;
  }

  recordResult(result: DataProviderResult<ProviderFundPayload>): void {
    const current = this.sourceStates.get(result.source_id);
    if (!current) return;
    const cacheHit = result.cache_hit === true;
    const liveSuccess = result.success && !cacheHit;
    const countsAsFailure = !result.success && !result.skipped_by_circuit_breaker;
    this.sourceStates.set(result.source_id, {
      ...current,
      last_success_at: liveSuccess ? nowIso() : current.last_success_at,
      last_failed_at: countsAsFailure ? nowIso() : current.last_failed_at,
      failure_count: countsAsFailure ? current.failure_count + 1 : current.failure_count,
      consecutive_failure_count: liveSuccess ? 0 : countsAsFailure ? current.consecutive_failure_count + 1 : current.consecutive_failure_count,
      last_latency_ms: cacheHit ? current.last_latency_ms : result.latency_ms ?? current.last_latency_ms,
      last_attempt_count: cacheHit ? current.last_attempt_count : result.attempt_count ?? current.last_attempt_count,
      cache_hit_count: cacheHit ? current.cache_hit_count + 1 : current.cache_hit_count,
      last_cache_hit_at: cacheHit ? nowIso() : current.last_cache_hit_at,
      circuit_open_until: this.circuitOpenUntilFor(current, result),
      circuit_open_count: countsAsFailure && this.shouldOpenCircuit(current) ? current.circuit_open_count + 1 : current.circuit_open_count
    });
  }

  isDemoMode(): boolean {
    return this.demoMode;
  }

  private enabledFor(info: DataSourceInfo): boolean {
    if (info.is_demo) return this.demoMode;
    if (info.source_type === "manual_import") return info.enabled;
    if (!this.usesCustomProviders && !this.enableLiveProviders) return false;
    return info.enabled;
  }

  private initialSourceState(info: DataSourceInfo, existing: DataSourceInfo | undefined): DataSourceInfo {
    return {
      ...info,
      enabled: this.enabledFor(info),
      last_success_at: existing?.last_success_at ?? info.last_success_at,
      last_failed_at: existing?.last_failed_at ?? info.last_failed_at,
      failure_count: existing?.failure_count ?? info.failure_count,
      consecutive_failure_count: existing?.consecutive_failure_count ?? info.consecutive_failure_count ?? 0,
      last_latency_ms: existing?.last_latency_ms ?? info.last_latency_ms ?? null,
      last_attempt_count: existing?.last_attempt_count ?? info.last_attempt_count ?? 0,
      cache_hit_count: existing?.cache_hit_count ?? info.cache_hit_count ?? 0,
      last_cache_hit_at: existing?.last_cache_hit_at ?? info.last_cache_hit_at ?? null,
      circuit_open_until: existing?.circuit_open_until ?? info.circuit_open_until ?? null,
      circuit_open_count: existing?.circuit_open_count ?? info.circuit_open_count ?? 0
    };
  }

  private async fetchProvider(
    provider: DataProvider<FundDataSourceInput, ProviderFundPayload>,
    input: FundDataSourceInput
  ): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = provider.sourceInfo();
    const cacheKey = this.cacheKeyFor(info.source_id, input);
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    const startedAt = Date.now();
    const circuitResult = this.circuitResultFor(info, startedAt);
    if (circuitResult) return circuitResult;

    const maxAttempts = Math.max(1, this.retryCount + 1);
    let lastResult: DataProviderResult<ProviderFundPayload> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await this.safeProviderFetch(provider, input);
      const normalized = this.normalizeProviderRuntimeResult(this.normalizeProviderIdentity(result, info));
      lastResult = this.rejectUnidentifiedFundResult(this.withRuntimeMetadata(normalized, attempt, startedAt, false, null), input.fund_code);
      if (lastResult.success) {
        this.writeCache(cacheKey, lastResult);
        return lastResult;
      }
      if (attempt < maxAttempts && this.shouldRetry(lastResult)) await this.wait(this.retryDelayMs(attempt));
      else break;
    }
    return lastResult ?? this.providerFailure(info, "Provider returned no result", startedAt, maxAttempts);
  }

  private async safeProviderFetch(
    provider: DataProvider<FundDataSourceInput, ProviderFundPayload>,
    input: FundDataSourceInput
  ): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = provider.sourceInfo();
    try {
      const result = await provider.fetch(input);
      return this.normalizeProviderResultShape(result as unknown, info);
    } catch (error) {
      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "unavailable",
        success: false,
        data: null,
        raw_reference: null,
        fetched_at: nowIso(),
        freshness: "unknown",
        warnings: ["Provider 抛出未捕获异常，SourceRegistry 已转换为显式失败结果。"],
        error: error instanceof Error ? error.message : String(error),
        is_demo: info.is_demo
      };
    }
  }

  private normalizeProviderResultShape(result: unknown, info: DataSourceInfo): DataProviderResult<ProviderFundPayload> {
    if (!this.isRecord(result)) {
      return this.malformedProviderResult(info, "Provider returned a non-object result.", null, []);
    }

    const warnings = Array.isArray(result.warnings) && result.warnings.every((warning) => typeof warning === "string")
      ? result.warnings
      : [];
    const invalidFields = [
      !Array.isArray(result.warnings) || !result.warnings.every((warning) => typeof warning === "string") ? "warnings" : null,
      !("data" in result) ? "data" : null,
      !this.isStringOrNull(result.raw_reference) ? "raw_reference" : null,
      !this.isStringOrNull(result.error) ? "error" : null,
      typeof result.is_demo !== "boolean" ? "is_demo" : null
    ].filter(Boolean) as string[];

    if (invalidFields.length) {
      return this.malformedProviderResult(
        info,
        `Provider returned malformed result fields: ${invalidFields.join(", ")}.`,
        this.isStringOrNull(result.raw_reference) ? result.raw_reference : null,
        warnings
      );
    }

    return result as unknown as DataProviderResult<ProviderFundPayload>;
  }

  private malformedProviderResult(info: DataSourceInfo, error: string, rawReference: string | null, warnings: string[]): DataProviderResult<ProviderFundPayload> {
    return {
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: rawReference,
      fetched_at: nowIso(),
      freshness: "unknown",
      warnings: [...warnings, `${error} SourceRegistry converted it to explicit failure.`],
      error,
      is_demo: info.is_demo
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private isStringOrNull(value: unknown): value is string | null {
    return typeof value === "string" || value === null;
  }

  private readCache(cacheKey: string): DataProviderResult<ProviderFundPayload> | null {
    if (this.cacheTtlMs <= 0) return null;
    const cached = this.resultCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return null;
    }
    return this.sanitizeProviderResult({
      ...cached.result,
      warnings: [...cached.result.warnings, "SourceRegistry cache hit; using recently fetched provider result."],
      fetched_at: nowIso(),
      cache_hit: true,
      cache_expires_at: new Date(cached.expiresAt).toISOString(),
      latency_ms: 0,
      skipped_by_circuit_breaker: false
    });
  }

  private writeCache(cacheKey: string, result: DataProviderResult<ProviderFundPayload>): void {
    if (this.cacheTtlMs <= 0 || !result.success || result.is_demo) return;
    this.resultCache.set(cacheKey, {
      sourceId: result.source_id,
      result: { ...result, warnings: [...result.warnings], cache_hit: false, cache_expires_at: new Date(Date.now() + this.cacheTtlMs).toISOString() },
      expiresAt: Date.now() + this.cacheTtlMs
    });
  }

  private withRuntimeMetadata(
    result: DataProviderResult<ProviderFundPayload>,
    attemptCount: number,
    startedAt: number,
    cacheHit: boolean,
    cacheExpiresAt: string | null
  ): DataProviderResult<ProviderFundPayload> {
    return this.sanitizeProviderResult({
      ...result,
      warnings: [...result.warnings],
      attempt_count: attemptCount,
      latency_ms: Date.now() - startedAt,
      cache_hit: cacheHit,
      cache_expires_at: cacheExpiresAt,
      skipped_by_circuit_breaker: false
    });
  }

  private normalizeProviderIdentity(
    result: DataProviderResult<ProviderFundPayload>,
    info: DataSourceInfo
  ): DataProviderResult<ProviderFundPayload> {
    const mismatchedFields = [
      result.source_id !== info.source_id ? "source_id" : null,
      result.source_name !== info.source_name ? "source_name" : null,
      result.source_type !== info.source_type ? "source_type" : null,
      result.trust_level !== info.trust_level ? "trust_level" : null,
      result.is_demo !== info.is_demo ? "is_demo" : null
    ].filter(Boolean) as string[];
    const warnings = mismatchedFields.length
      ? [
          ...result.warnings,
          `SourceRegistry normalized provider result identity to registered sourceInfo fields: ${mismatchedFields.join(", ")}.`
        ]
      : result.warnings;
    return {
      ...result,
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      warnings,
      is_demo: info.is_demo || result.is_demo
    };
  }

  private normalizeProviderRuntimeResult(result: DataProviderResult<ProviderFundPayload>): DataProviderResult<ProviderFundPayload> {
    const warnings = [...result.warnings];
    let dataStatus = result.data_status;
    let freshness = result.freshness;
    let fetchedAt = result.fetched_at;
    let success = result.success;
    let data = result.data;
    let error = result.error;

    if (!DATA_STATUSES.has(dataStatus)) {
      warnings.push(`SourceRegistry normalized invalid data_status=${String(dataStatus)} to unavailable.`);
      dataStatus = "unavailable";
      success = false;
    }
    if (!FRESHNESS_VALUES.has(freshness)) {
      warnings.push(`SourceRegistry normalized invalid freshness=${String(freshness)} to unknown.`);
      freshness = "unknown";
    }
    if (!this.isValidIsoTimestamp(fetchedAt)) {
      warnings.push("SourceRegistry replaced invalid fetched_at timestamp with registry fetch time.");
      fetchedAt = nowIso();
    }
    if (typeof (result.success as unknown) !== "boolean") {
      warnings.push(`SourceRegistry normalized invalid success=${String(result.success)} to false.`);
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider returned non-boolean success flag.";
    }
    if (success && dataStatus === "unavailable") {
      warnings.push("Provider reported success with data_status=unavailable; SourceRegistry converted it to explicit failure.");
      success = false;
      freshness = "unknown";
      error = error ?? "Provider returned success with unavailable data_status.";
    }
    if (success && dataStatus === "demo" && !result.is_demo) {
      warnings.push("Provider reported data_status=demo without is_demo=true; SourceRegistry converted it to explicit failure.");
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider returned demo data_status without demo marker.";
    }
    if (success && result.is_demo && !this.demoMode) {
      warnings.push("Provider reported demo-marked data while demo mode is disabled; SourceRegistry converted it to explicit failure.");
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider returned demo-marked data while demo mode is disabled.";
    }
    if (success && result.is_demo && dataStatus !== "demo") {
      warnings.push(`SourceRegistry normalized demo-marked provider data_status=${dataStatus} to demo.`);
      dataStatus = "demo";
    }
    if (success && !data) {
      warnings.push("Provider reported success without data; SourceRegistry converted it to explicit failure.");
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider reported success without data.";
    }
    if (success && !result.is_demo && !this.hasTraceableRawReference(result.raw_reference)) {
      warnings.push("Provider reported real-data success without raw_reference; SourceRegistry converted it to explicit failure.");
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider reported real-data success without traceable raw_reference.";
    }
    if (success && !this.hasUsableProviderPayload(data)) {
      warnings.push("Provider reported success without any usable business payload fields; SourceRegistry converted it to explicit failure.");
      success = false;
      dataStatus = "unavailable";
      freshness = "unknown";
      error = error ?? "Provider reported success without usable business payload fields.";
    }
    if (!success && data) {
      warnings.push("Provider reported failure with data; SourceRegistry discarded the payload.");
      data = null;
    }
    if (!success) dataStatus = "unavailable";

    return this.sanitizeProviderResult({
      ...result,
      data_status: dataStatus,
      success,
      data,
      fetched_at: fetchedAt,
      freshness,
      warnings,
      error
    });
  }

  private isValidIsoTimestamp(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }

  private hasTraceableRawReference(value: string | null): boolean {
    return typeof value === "string" && value.trim().length > 0;
  }

  private hasUsableProviderPayload(payload: ProviderFundPayload | null | undefined): boolean {
    if (!payload) return false;
    const validated = this.validatedContextPayload(payload);
    return (
      this.hasNonEmptyString(validated.fund_name) ||
      this.hasNonEmptyString(validated.fund_type) ||
      validated.current_nav !== undefined ||
      validated.daily_return !== undefined ||
      Boolean(validated.nav_history?.length) ||
      Boolean(Object.keys(validated.stage_returns ?? {}).length) ||
      Boolean(validated.portfolio_holdings?.length) ||
      this.hasNonEmptyString(validated.holdings_as_of) ||
      this.hasNonEmptyString(validated.holdings_source) ||
      Boolean(validated.fund_report_refs?.length) ||
      Boolean(validated.fund_report_documents?.length) ||
      Boolean(validated.themes?.length) ||
      Boolean(validated.policy_signals?.length) ||
      Boolean(validated.macro_indicators?.length) ||
      Boolean(validated.news_summaries?.length) ||
      validated.social_sentiment_score !== undefined
    );
  }

  private hasNonEmptyString(value: string | undefined | null): boolean {
    return typeof value === "string" && value.trim().length > 0;
  }

  private rejectUnidentifiedFundResult(
    result: DataProviderResult<ProviderFundPayload>,
    fundCode: string
  ): DataProviderResult<ProviderFundPayload> {
    if (!result.success || !result.data || this.canUsePayloadForRequestedFund(result, fundCode)) return result;
    const providerFundCode = result.data.fund_code?.trim();
    const isMissingFundCode = !providerFundCode;
    const error = isMissingFundCode
      ? `Provider returned core fund payload without fund_code; expected ${fundCode}.`
      : `Provider returned mismatched fund_code=${providerFundCode}; expected ${fundCode}.`;
    const warning = isMissingFundCode
      ? `${result.source_name} returned core fund payload without fund_code; requested fund_code=${fundCode}. SourceRegistry rejected this payload for the current request.`
      : `${result.source_name} returned fund_code=${providerFundCode}; requested fund_code=${fundCode}. SourceRegistry rejected this payload for the current request.`;
    return this.sanitizeProviderResult({
      ...result,
      data_status: "unavailable",
      success: false,
      data: null,
      freshness: "unknown",
      warnings: [...result.warnings, warning],
      error
    });
  }

  private circuitResultFor(info: DataSourceInfo, startedAt: number): DataProviderResult<ProviderFundPayload> | null {
    const current = this.sourceStates.get(info.source_id);
    if (!current || this.cooldownRemainingMs(current) <= 0) return null;
    return this.sanitizeProviderResult({
      source_id: current.source_id,
      source_name: current.source_name,
      source_type: current.source_type,
      trust_level: current.trust_level,
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: null,
      fetched_at: nowIso(),
      freshness: "unknown",
      warnings: [`SourceRegistry circuit breaker is open until ${current.circuit_open_until}; provider call skipped.`],
      error: "Provider skipped by circuit breaker after repeated failures.",
      is_demo: current.is_demo,
      attempt_count: 0,
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      cache_expires_at: null,
      skipped_by_circuit_breaker: true
    });
  }

  private shouldRetry(result: DataProviderResult<ProviderFundPayload>): boolean {
    if (result.success || result.is_demo) return false;
    const message = `${result.error ?? ""} ${result.warnings.join(" ")}`.toLowerCase();
    return /timeout|abort|network|fetch failed|econnreset|socket|temporar|5\d\d|rate/u.test(message);
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(1000, 120 * 2 ** Math.max(0, attempt - 1));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private cacheKeyFor(sourceId: string, input: FundDataSourceInput): string {
    return JSON.stringify({
      source_id: sourceId,
      fund_code: input.fund_code,
      required_data: [...input.required_data].sort(),
      context: this.contextSignature(input.context),
      demo_mode: input.demo_mode
    });
  }

  private contextSignature(context: ProviderFundPayload | undefined): Record<string, unknown> {
    if (!context) return {};
    const validated = this.validatedContextPayload(context);
    return {
      fund_code: this.publicOptionalText(validated.fund_code),
      fund_name: this.publicOptionalText(validated.fund_name),
      fund_type: this.publicOptionalText(validated.fund_type),
      current_nav: validated.current_nav,
      daily_return: validated.daily_return,
      nav_history: this.navHistorySignature(validated.nav_history, validated.nav_history_dates),
      stage_returns: this.stageReturnSignature(validated.stage_returns),
      themes: this.publicStringList(validated.themes).sort(),
      portfolio_holdings: this.publicStringList(validated.portfolio_holdings).sort().slice(0, 50),
      holdings_as_of: this.publicOptionalText(validated.holdings_as_of),
      fund_report_refs: this.publicStringList(validated.fund_report_refs).sort().slice(0, 20),
      fund_report_documents: this.fundReportDocumentSignature(validated.fund_report_documents),
      policy_signals: this.publicStringList(validated.policy_signals).sort().slice(0, 20),
      news_summaries: this.publicStringList(validated.news_summaries).sort().slice(0, 20),
      macro_indicators: this.macroIndicatorSignature(validated.macro_indicators),
      social_sentiment_score: validated.social_sentiment_score
    };
  }

  private publicStringList(values: string[] | undefined): string[] {
    return (values ?? []).map((value) => sanitizePublicText(value));
  }

  private publicOptionalText(value: string | undefined | null): string | undefined | null {
    return value === undefined || value === null ? value : sanitizePublicText(value);
  }

  private macroIndicatorSignature(indicators: ProviderFundPayload["macro_indicators"] | undefined): Array<Record<string, unknown>> {
    return (indicators ?? [])
      .map((indicator) => ({
        country_code: sanitizePublicText(indicator.country_code),
        indicator_id: sanitizePublicText(indicator.indicator_id),
        date: sanitizePublicText(indicator.date),
        value: indicator.value,
        source_url: sanitizePublicText(indicator.source_url),
        source_name: sanitizePublicText(indicator.source_name)
      }))
      .sort((left, right) =>
        [
          String(left.country_code ?? ""),
          String(left.indicator_id ?? ""),
          String(left.date ?? ""),
          String(left.source_name ?? "")
        ].join("|").localeCompare(
          [
            String(right.country_code ?? ""),
            String(right.indicator_id ?? ""),
            String(right.date ?? ""),
            String(right.source_name ?? "")
          ].join("|")
        )
      )
      .slice(0, 50);
  }

  private navHistorySignature(
    navHistory: ProviderFundPayload["nav_history"] | undefined,
    navHistoryDates: ProviderFundPayload["nav_history_dates"] | undefined
  ): Record<string, unknown> | undefined {
    if (!navHistory?.length) return undefined;
    const dates = this.publicStringList(navHistoryDates);
    return {
      count: navHistory.length,
      latest_nav: navHistory.at(-1),
      latest_date: dates.at(-1) ?? null,
      sha256: createHash("sha256").update(JSON.stringify({ navHistory, dates })).digest("hex")
    };
  }

  private stageReturnSignature(stageReturns: ProviderFundPayload["stage_returns"] | undefined): Array<Record<string, unknown>> | undefined {
    const entries = Object.entries(stageReturns ?? {})
      .filter(([, value]) => this.isFiniteNumber(value))
      .map(([period, value]) => ({ period: sanitizePublicText(period), value }))
      .sort((left, right) => left.period.localeCompare(right.period));
    return entries.length ? entries : undefined;
  }

  private fundReportDocumentSignature(documents: ProviderFundPayload["fund_report_documents"] | undefined): Array<Record<string, unknown>> {
    return (documents ?? [])
      .map((document) => ({
        title: sanitizePublicText(document.title),
        announcement_id: sanitizePublicText(document.announcement_id),
        published_at: this.publicOptionalText(document.published_at),
        document_kind: sanitizePublicText(document.document_kind),
        detail_url: document.detail_url ? sanitizePublicText(document.detail_url) : null,
        pdf_url: document.pdf_url ? sanitizePublicText(document.pdf_url) : null,
        pdf_verified: document.pdf_verified,
        pdf_content_type: this.publicOptionalText(document.pdf_content_type),
        pdf_content_length: document.pdf_content_length,
        pdf_sha256: this.publicOptionalText(document.pdf_sha256 ?? null),
        source_name: sanitizePublicText(document.source_name),
        source_type: sanitizePublicText(document.source_type),
        trust_level: sanitizePublicText(document.trust_level)
      }))
      .sort((left, right) =>
        [
          String(left.announcement_id ?? ""),
          String(left.pdf_url ?? ""),
          String(left.detail_url ?? ""),
          String(left.title ?? "")
        ].join("|").localeCompare(
          [
            String(right.announcement_id ?? ""),
            String(right.pdf_url ?? ""),
            String(right.detail_url ?? ""),
            String(right.title ?? "")
          ].join("|")
        )
      )
      .slice(0, 20);
  }

  private cacheEntryCountFor(sourceId: string): number {
    const now = Date.now();
    let count = 0;
    for (const [cacheKey, cached] of this.resultCache.entries()) {
      if (cached.expiresAt <= now) {
        this.resultCache.delete(cacheKey);
        continue;
      }
      if (cached.sourceId === sourceId) count += 1;
    }
    return count;
  }

  private providerFailure(
    info: DataSourceInfo,
    error: string,
    startedAt: number,
    attemptCount: number
  ): DataProviderResult<ProviderFundPayload> {
    return this.sanitizeProviderResult({
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: null,
      fetched_at: nowIso(),
      freshness: "unknown",
      warnings: ["Provider 调度层未收到返回结果。"],
      error,
      is_demo: info.is_demo,
      attempt_count: attemptCount,
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      cache_expires_at: null,
      skipped_by_circuit_breaker: false
    });
  }

  private sanitizeProviderResult(result: DataProviderResult<ProviderFundPayload>): DataProviderResult<ProviderFundPayload> {
    return sanitizePublicStructure(result);
  }

  private shouldOpenCircuit(current: DataSourceInfo): boolean {
    if (this.failureCooldownMs <= 0 || this.failureThreshold <= 0) return false;
    return current.consecutive_failure_count + 1 >= this.failureThreshold;
  }

  private circuitOpenUntilFor(current: DataSourceInfo, result: DataProviderResult<ProviderFundPayload>): string | null {
    if (result.success) return null;
    if (result.skipped_by_circuit_breaker) return current.circuit_open_until;
    if (!this.shouldOpenCircuit(current)) return current.circuit_open_until;
    return new Date(Date.now() + this.failureCooldownMs).toISOString();
  }

  private cooldownRemainingMs(source: DataSourceInfo): number {
    if (!source.circuit_open_until) return 0;
    return Math.max(0, new Date(source.circuit_open_until).getTime() - Date.now());
  }

  private healthStatusFor(source: DataSourceInfo): "healthy" | "disabled" | "failing" | "demo_only" | "cooldown" {
    if (source.is_demo) return "demo_only";
    if (!source.enabled) return "disabled";
    if (this.cooldownRemainingMs(source) > 0) return "cooldown";
    return source.consecutive_failure_count > 0 ? "failing" : "healthy";
  }

  private coverageNoteFor(
    requirement: CoverageRequirement,
    gapLevel: "covered" | "partial" | "missing" | "requires_license"
  ): string {
    if (requirement === "official_current_nav") {
      return "强结论需要基金公司官网、监管披露、授权 API 或其他官方/授权来源确认当前净值；聚合源和人工导入只能支持弱结论。";
    }
    if (requirement === "official_nav_history") {
      return "强结论需要官方/授权历史净值序列支撑低位和拐点判断；聚合历史净值只能作为交叉校验或弱分析输入。";
    }
    if (requirement === "official_fund_reports") {
      return "强结论需要自动官方/授权 provider 获取的定期报告正文或官方 PDF 元数据；聚合索引、报告提示公告和人工导入只能支持 partial。协调器只复用已校验官方 PDF 元数据，不单独计作外部来源覆盖。";
    }
    if (gapLevel === "covered") return "已有权威 provider 接入，但仍应做缓存、重试和交叉校验。";
    if (gapLevel === "partial") return "已有 provider 可支撑弱结论，需要补官方或授权来源。";
    if (gapLevel === "requires_license") return "主要依赖授权数据源，接入前需要完成商务和密钥配置。";
    return "尚无可用 provider，Argus 必须把该项列入数据缺口和工程任务。";
  }

  private manualWorkaroundSourcesFor(
    requirement: CoverageRequirement,
    catalog: DataSourceCatalogEntry[]
  ): DataSourceCatalogEntry[] {
    const workaroundRequirements: Partial<Record<CoverageRequirement, string[]>> = {
      official_current_nav: ["current_nav"],
      official_nav_history: ["nav_history"],
      official_fund_reports: ["manual_official_report_workaround"],
      fund_meta: ["fund_meta"],
      current_nav: ["current_nav"],
      nav_history: ["nav_history"],
      holdings: ["holdings"],
      fund_reports: ["manual_official_report_workaround"]
    };
    const targets = workaroundRequirements[requirement] ?? [];
    if (!targets.length) return [];
    return catalog.filter(
      (source) =>
        source.integration_status === "manual" &&
        source.source_type === "manual_import" &&
        targets.some((target) => source.recommended_for.includes(target) || source.coverage.includes(target))
    );
  }

  private mergeContext(left: ProviderFundPayload, right: ProviderFundPayload, state: ContextMergeState, priority: number): ProviderFundPayload {
    const merged: ProviderFundPayload = {
      ...left,
      fund_report_refs: [...new Set([...(left.fund_report_refs ?? []), ...(right.fund_report_refs ?? [])])],
      fund_report_documents: [...(left.fund_report_documents ?? []), ...(right.fund_report_documents ?? [])],
      portfolio_holdings: left.portfolio_holdings ?? [],
      themes: [...new Set([...(left.themes ?? []), ...(right.themes ?? [])])],
      policy_signals: [...new Set([...(left.policy_signals ?? []), ...(right.policy_signals ?? [])])],
      macro_indicators: this.mergeMacroIndicators(left.macro_indicators, right.macro_indicators),
      news_summaries: [...new Set([...(left.news_summaries ?? []), ...(right.news_summaries ?? [])])]
    };

    this.setPreferredContextField(merged, state, "fund_code", right.fund_code, priority);
    this.setPreferredContextField(merged, state, "fund_name", right.fund_name, priority);
    this.setPreferredContextField(merged, state, "fund_type", right.fund_type, priority);
    this.setPreferredContextField(merged, state, "current_nav", right.current_nav, priority);
    this.setPreferredContextField(merged, state, "daily_return", right.daily_return, priority);
    this.mergeNavHistoryContext(merged, right, state, priority);
    this.mergeStageReturnsContext(merged, right.stage_returns, state, priority);
    this.mergeHoldingsContext(merged, right, state, priority);
    if (priority > Number.NEGATIVE_INFINITY) this.setIfMissing(merged, "social_sentiment_score", right.social_sentiment_score);
    return merged;
  }

  private mergeContextForResult(
    left: ProviderFundPayload,
    result: DataProviderResult<ProviderFundPayload>,
    state: ContextMergeState,
    fundCode: string
  ): ProviderFundPayload {
    if (!result.data) return left;
    return this.mergeContext(left, this.contextPayloadForResult(result, fundCode), state, this.contextPayloadPriority(result));
  }

  private contextPayloadForResult(result: DataProviderResult<ProviderFundPayload>, fundCode: string): ProviderFundPayload {
    const payload = result.data!;
    if (!this.matchesRequestedFund(fundCode, payload)) return {};
    if (result.source_type === "manual_import" && !result.is_demo) return this.validatedContextPayload(this.manualImportContextPayload(payload), fundCode);
    if (this.canMergeFundCoreContext(result)) return this.validatedContextPayload(payload, fundCode);
    return this.validatedContextPayload({
      themes: payload.themes,
      policy_signals: payload.policy_signals,
      macro_indicators: payload.macro_indicators,
      news_summaries: payload.news_summaries
    }, fundCode);
  }

  private manualImportContextPayload(payload: ProviderFundPayload): ProviderFundPayload {
    return {
      fund_code: payload.fund_code,
      fund_name: payload.fund_name,
      fund_type: payload.fund_type,
      current_nav: payload.current_nav,
      daily_return: payload.daily_return,
      nav_history: payload.nav_history,
      nav_history_dates: payload.nav_history_dates,
      stage_returns: payload.stage_returns,
      portfolio_holdings: payload.portfolio_holdings,
      holdings_as_of: payload.holdings_as_of,
      holdings_source: payload.holdings_source,
      themes: payload.themes,
      policy_signals: payload.policy_signals,
      macro_indicators: payload.macro_indicators,
      news_summaries: payload.news_summaries,
      social_sentiment_score: payload.social_sentiment_score
    };
  }

  private validatedContextPayload(payload: ProviderFundPayload, fundCode?: string): ProviderFundPayload {
    const validated: ProviderFundPayload = { ...payload };
    if (!this.matchesRequestedFund(fundCode, validated)) return {};
    if (validated.current_nav !== undefined && !this.isValidNavValue(validated.current_nav)) validated.current_nav = undefined;
    if (validated.daily_return !== undefined && !this.isFiniteNumber(validated.daily_return)) validated.daily_return = undefined;
    if (validated.social_sentiment_score !== undefined && !this.isFiniteNumber(validated.social_sentiment_score)) validated.social_sentiment_score = undefined;
    validated.stage_returns = this.validStageReturns(validated.stage_returns);
    validated.portfolio_holdings = this.validStringList(validated.portfolio_holdings);
    validated.fund_report_refs = this.validStringList(validated.fund_report_refs);
    validated.fund_report_documents = validFundReportDocuments(validated.fund_report_documents);
    validated.themes = this.validStringList(validated.themes);
    validated.policy_signals = this.validStringList(validated.policy_signals);
    validated.news_summaries = this.validStringList(validated.news_summaries);
    validated.macro_indicators = this.validMacroIndicators(validated.macro_indicators);
    const navHistory = this.validNavHistory(validated.nav_history, validated.nav_history_dates);
    validated.nav_history = navHistory.navHistory;
    validated.nav_history_dates = navHistory.navHistoryDates;
    return validated;
  }

  private validStringList(values: string[] | undefined): string[] | undefined {
    if (!Array.isArray(values)) return undefined;
    const cleaned = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return cleaned.length ? [...new Set(cleaned)] : undefined;
  }

  private validStageReturns(stageReturns: ProviderFundPayload["stage_returns"]): ProviderFundPayload["stage_returns"] {
    if (!stageReturns) return stageReturns;
    const entries = Object.entries(stageReturns).filter(([, value]) => this.isFiniteNumber(value));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  private validMacroIndicators(indicators: ProviderFundPayload["macro_indicators"]): ProviderFundPayload["macro_indicators"] {
    if (!Array.isArray(indicators)) return undefined;
    const valid = indicators.filter((indicator) => this.isValidMacroIndicator(indicator));
    return valid.length ? valid : undefined;
  }

  private isValidMacroIndicator(indicator: unknown): indicator is NonNullable<ProviderFundPayload["macro_indicators"]>[number] {
    if (!this.isRecord(indicator)) return false;
    return (
      typeof indicator.country_code === "string" &&
      indicator.country_code.trim().length > 0 &&
      typeof indicator.country_name === "string" &&
      indicator.country_name.trim().length > 0 &&
      typeof indicator.indicator_id === "string" &&
      indicator.indicator_id.trim().length > 0 &&
      typeof indicator.indicator_name === "string" &&
      indicator.indicator_name.trim().length > 0 &&
      this.isFiniteNumber(indicator.value as number | undefined) &&
      typeof indicator.date === "string" &&
      indicator.date.trim().length > 0 &&
      (typeof indicator.unit === "string" || indicator.unit === null) &&
      typeof indicator.source_url === "string" &&
      indicator.source_url.trim().length > 0 &&
      typeof indicator.source_name === "string" &&
      indicator.source_name.trim().length > 0 &&
      this.isValidIsoTimestamp(indicator.fetched_at as string)
    );
  }

  private validNavHistory(
    navHistory: number[] | undefined,
    navHistoryDates: string[] | undefined
  ): { navHistory: number[] | undefined; navHistoryDates: string[] | undefined } {
    if (!navHistory?.length) return { navHistory, navHistoryDates };
    const requiresPairedDates = Boolean(navHistoryDates?.length);
    const validValues: number[] = [];
    const validDates: string[] = [];
    for (let index = 0; index < navHistory.length; index += 1) {
      const nav = navHistory[index];
      if (!this.isValidNavValue(nav)) continue;
      const date = navHistoryDates?.[index];
      if (requiresPairedDates && !date) continue;
      validValues.push(nav);
      if (date) validDates.push(date);
    }
    return {
      navHistory: validValues.length ? validValues : undefined,
      navHistoryDates: validValues.length && requiresPairedDates ? validDates : undefined
    };
  }

  private isValidNavValue(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  }

  private isFiniteNumber(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }

  private matchesRequestedFund(fundCode: string | undefined, payload: ProviderFundPayload | null | undefined): boolean {
    const providerFundCode = payload?.fund_code?.trim();
    return !fundCode || !providerFundCode || providerFundCode === fundCode;
  }

  private canUsePayloadForRequestedFund(result: DataProviderResult<ProviderFundPayload>, fundCode: string): boolean {
    const providerFundCode = result.data?.fund_code?.trim();
    if (!this.canMergeFundCoreContext(result)) return this.matchesRequestedFund(fundCode, result.data);
    return Boolean(providerFundCode) && providerFundCode === fundCode;
  }

  private initialContextMergeState(context: ProviderFundPayload): ContextMergeState {
    const state: ContextMergeState = {
      coreFieldPriorities: {},
      stageReturnPriorities: {},
      navHistoryPriority: Number.NEGATIVE_INFINITY,
      holdingsPriority: Number.NEGATIVE_INFINITY
    };
    const initialPriority = 25;
    for (const key of ["fund_code", "fund_name", "fund_type", "current_nav", "daily_return"] as ContextCoreField[]) {
      if (context[key] !== undefined && context[key] !== null) state.coreFieldPriorities[key] = initialPriority;
    }
    if (context.nav_history?.length) state.navHistoryPriority = initialPriority;
    if (context.portfolio_holdings?.length) state.holdingsPriority = initialPriority;
    for (const period of Object.keys(context.stage_returns ?? {})) {
      state.stageReturnPriorities[period] = initialPriority;
    }
    return state;
  }

  private setIfMissing<K extends keyof ProviderFundPayload>(target: ProviderFundPayload, key: K, value: ProviderFundPayload[K]): void {
    if (target[key] === undefined && value !== undefined && value !== null) target[key] = value;
  }

  private setPreferredContextField<K extends ContextCoreField>(
    target: ProviderFundPayload,
    state: ContextMergeState,
    key: K,
    value: ProviderFundPayload[K],
    priority: number,
    replaceOnTie = false
  ): void {
    if (value === undefined || value === null) return;
    const currentPriority = state.coreFieldPriorities[key] ?? Number.NEGATIVE_INFINITY;
    if (target[key] === undefined || priority > currentPriority || (replaceOnTie && priority === currentPriority)) {
      target[key] = value;
      state.coreFieldPriorities[key] = priority;
    }
  }

  private mergeNavHistoryContext(target: ProviderFundPayload, payload: ProviderFundPayload, state: ContextMergeState, priority: number): void {
    if (!this.shouldUseContextNavHistory(payload, target, priority, state.navHistoryPriority)) return;
    target.nav_history = payload.nav_history;
    target.nav_history_dates = payload.nav_history_dates;
    state.navHistoryPriority = priority;
    this.setPreferredContextField(target, state, "current_nav", payload.current_nav, priority, true);
    this.setPreferredContextField(target, state, "daily_return", payload.daily_return, priority, true);
  }

  private shouldUseContextNavHistory(
    candidate: ProviderFundPayload,
    current: ProviderFundPayload,
    candidatePriority: number,
    currentPriority: number
  ): boolean {
    if (!candidate.nav_history?.length) return false;
    if (!current.nav_history?.length) return true;
    if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
    const candidateLatest = candidate.nav_history_dates?.at(-1);
    const currentLatest = current.nav_history_dates?.at(-1);
    if (candidateLatest && currentLatest && candidateLatest !== currentLatest) return candidateLatest > currentLatest;
    if (candidateLatest && !currentLatest) return true;
    if (!candidateLatest && currentLatest) return false;
    return candidate.nav_history.length > current.nav_history.length;
  }

  private mergeStageReturnsContext(
    target: ProviderFundPayload,
    stageReturns: ProviderFundPayload["stage_returns"],
    state: ContextMergeState,
    priority: number
  ): void {
    if (!stageReturns) return;
    const mergedStageReturns = (target.stage_returns ??= {});
    for (const [period, value] of Object.entries(stageReturns)) {
      const currentPriority = state.stageReturnPriorities[period] ?? Number.NEGATIVE_INFINITY;
      if (priority > currentPriority || mergedStageReturns[period] === undefined) {
        mergedStageReturns[period] = value;
        state.stageReturnPriorities[period] = priority;
      }
    }
  }

  private mergeHoldingsContext(target: ProviderFundPayload, payload: ProviderFundPayload, state: ContextMergeState, priority: number): void {
    if (!payload.portfolio_holdings?.length) return;
    if (!target.portfolio_holdings?.length || priority > state.holdingsPriority) {
      this.assignContextHoldings(target, payload);
      state.holdingsPriority = priority;
      return;
    }
    if (priority < state.holdingsPriority) return;

    const candidateDate = payload.holdings_as_of;
    const currentDate = target.holdings_as_of;
    if (candidateDate && (!currentDate || candidateDate > currentDate)) {
      this.assignContextHoldings(target, payload);
      return;
    }
    if (currentDate && candidateDate && candidateDate < currentDate) return;

    target.portfolio_holdings = [...new Set([...(target.portfolio_holdings ?? []), ...payload.portfolio_holdings])];
    this.setIfMissing(target, "holdings_as_of", candidateDate);
    this.setIfMissing(target, "holdings_source", payload.holdings_source);
  }

  private assignContextHoldings(target: ProviderFundPayload, payload: ProviderFundPayload): void {
    target.portfolio_holdings = [...new Set(payload.portfolio_holdings ?? [])];
    target.holdings_as_of = payload.holdings_as_of;
    target.holdings_source = payload.holdings_source;
  }

  private contextPayloadPriority(result: DataProviderResult<ProviderFundPayload>): number {
    if (!this.canMergeFundCoreContext(result)) return Number.NEGATIVE_INFINITY;
    if (this.isAuthoritativeContextSource(result)) return 40;
    if (!result.is_demo && result.source_type === "manual_import") return 20;
    if (!result.is_demo) return 10;
    return 0;
  }

  private isAuthoritativeContextSource(result: DataProviderResult<ProviderFundPayload>): boolean {
    return !result.is_demo && result.source_type !== "manual_import" && result.trust_level === "A";
  }

  private canMergeFundCoreContext(result: DataProviderResult<ProviderFundPayload>): boolean {
    if (result.is_demo) return true;
    return FUND_CORE_CONTEXT_SOURCE_TYPES.has(result.source_type);
  }

  private mergeMacroIndicators(
    left: ProviderFundPayload["macro_indicators"] | undefined,
    right: ProviderFundPayload["macro_indicators"] | undefined
  ): ProviderFundPayload["macro_indicators"] | undefined {
    if (!left?.length && !right?.length) return left ?? right;
    const merged = new Map<string, NonNullable<ProviderFundPayload["macro_indicators"]>[number]>();
    for (const indicator of [...(left ?? []), ...(right ?? [])]) {
      merged.set(`${indicator.country_code}:${indicator.indicator_id}:${indicator.date}`, indicator);
    }
    return [...merged.values()];
  }
}
