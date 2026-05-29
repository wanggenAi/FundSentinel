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
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "./sourceTypes.js";
import { listDataSourceCatalog } from "./sourceCatalog.js";
import { nowIso } from "../schemas/index.js";
import type { DataRequirement } from "../schemas/index.js";

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
      new FundCompanyReportProvider(),
      new CninfoReportProvider(),
      new GovCnPolicyProvider(),
      new MofFiscalProvider(),
      new SafeMacroProvider(),
      new PbcMacroProvider(),
      new StatsGovMacroProvider(),
      new SecEdgarProvider(),
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
    return [...this.sourceStates.values()].sort((a, b) => a.priority - b.priority);
  }

  health(): Array<
    DataSourceInfo & { health_status: "healthy" | "disabled" | "failing" | "demo_only" | "cooldown"; cache_entries: number; cooldown_remaining_ms: number }
  > {
    return this.listSources().map((source) => ({
      ...source,
      health_status: this.healthStatusFor(source),
      cache_entries: this.cacheEntryCountFor(source.source_id),
      cooldown_remaining_ms: this.cooldownRemainingMs(source)
    }));
  }

  catalog() {
    return listDataSourceCatalog();
  }

  coverageMatrix(): Array<{
    requirement: DataRequirement | "official_current_nav" | "official_nav_history" | "official_fund_reports" | "benchmark";
    source_ids: string[];
    implemented_source_ids: string[];
    coordinator_source_ids: string[];
    manual_source_ids: string[];
    authoritative_source_ids: string[];
    needs_license_source_ids: string[];
    gap_level: "covered" | "partial" | "missing" | "requires_license";
    notes: string;
  }> {
    const catalog = this.catalog();
    const requirements: Array<DataRequirement | "official_current_nav" | "official_nav_history" | "official_fund_reports" | "benchmark"> = [
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

    return requirements.map((requirement) => {
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
      const authoritative = matching.filter((source) => source.quality_tier === "authoritative");
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
        authoritative_source_ids: authoritative.map((source) => source.source_id),
        needs_license_source_ids: needsLicense.map((source) => source.source_id),
        gap_level: gapLevel,
        notes: this.coverageNoteFor(requirement, gapLevel)
      };
    });
  }

  providerCandidates(): Array<{ source_id: string; source_name: string; source_type: string; priority: number; is_demo: boolean; enabled: boolean }> {
    return this.listSources().map((source) => ({
      source_id: source.source_id,
      source_name: source.source_name,
      source_type: source.source_type,
      priority: source.priority,
      is_demo: source.is_demo,
      enabled: source.enabled
    }));
  }

  async fetchAll(input: FundDataSourceInput): Promise<Array<DataProviderResult<ProviderFundPayload>>> {
    const activeProviders = this.providers
      .filter((provider) => {
        const info = this.sourceStates.get(provider.sourceInfo().source_id)!;
        return info.enabled;
      })
      .sort((a, b) => this.sourceStates.get(a.sourceInfo().source_id)!.priority - this.sourceStates.get(b.sourceInfo().source_id)!.priority);

    const results: Array<DataProviderResult<ProviderFundPayload>> = [];
    let context: ProviderFundPayload = {};
    for (const provider of activeProviders) {
      const providerInput = { ...input, context, demo_mode: this.demoMode };
      if (!provider.canHandle(providerInput)) continue;
      const result = await this.fetchProvider(provider, providerInput);
      this.recordResult(result);
      results.push(result);
      if (result.success && result.data) context = this.mergeContext(context, result.data);
    }
    return results;
  }

  recordResult(result: DataProviderResult<ProviderFundPayload>): void {
    const current = this.sourceStates.get(result.source_id);
    if (!current) return;
    const countsAsFailure = !result.success && !result.skipped_by_circuit_breaker;
    this.sourceStates.set(result.source_id, {
      ...current,
      last_success_at: result.success ? nowIso() : current.last_success_at,
      last_failed_at: countsAsFailure ? nowIso() : current.last_failed_at,
      failure_count: countsAsFailure ? current.failure_count + 1 : current.failure_count,
      consecutive_failure_count: result.success ? 0 : countsAsFailure ? current.consecutive_failure_count + 1 : current.consecutive_failure_count,
      last_latency_ms: result.latency_ms ?? current.last_latency_ms,
      last_attempt_count: result.attempt_count ?? current.last_attempt_count,
      cache_hit_count: result.cache_hit ? current.cache_hit_count + 1 : current.cache_hit_count,
      last_cache_hit_at: result.cache_hit ? nowIso() : current.last_cache_hit_at,
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
      lastResult = this.withRuntimeMetadata(result, attempt, startedAt, false, null);
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
    try {
      return await provider.fetch(input);
    } catch (error) {
      const info = provider.sourceInfo();
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

  private readCache(cacheKey: string): DataProviderResult<ProviderFundPayload> | null {
    if (this.cacheTtlMs <= 0) return null;
    const cached = this.resultCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.resultCache.delete(cacheKey);
      return null;
    }
    return {
      ...cached.result,
      warnings: [...cached.result.warnings, "SourceRegistry cache hit; using recently fetched provider result."],
      fetched_at: nowIso(),
      cache_hit: true,
      cache_expires_at: new Date(cached.expiresAt).toISOString(),
      latency_ms: 0,
      skipped_by_circuit_breaker: false
    };
  }

  private writeCache(cacheKey: string, result: DataProviderResult<ProviderFundPayload>): void {
    if (this.cacheTtlMs <= 0 || !result.success || result.is_demo) return;
    this.resultCache.set(cacheKey, {
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
    return {
      ...result,
      warnings: [...result.warnings],
      attempt_count: attemptCount,
      latency_ms: Date.now() - startedAt,
      cache_hit: cacheHit,
      cache_expires_at: cacheExpiresAt,
      skipped_by_circuit_breaker: false
    };
  }

  private circuitResultFor(info: DataSourceInfo, startedAt: number): DataProviderResult<ProviderFundPayload> | null {
    const current = this.sourceStates.get(info.source_id);
    if (!current || this.cooldownRemainingMs(current) <= 0) return null;
    return {
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
    };
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
    return {
      fund_name: context.fund_name,
      fund_type: context.fund_type,
      themes: [...(context.themes ?? [])].sort(),
      portfolio_holdings: [...(context.portfolio_holdings ?? [])].sort().slice(0, 50),
      holdings_as_of: context.holdings_as_of,
      fund_report_refs: [...(context.fund_report_refs ?? [])].sort().slice(0, 20)
    };
  }

  private cacheEntryCountFor(sourceId: string): number {
    return [...this.resultCache.keys()].filter((key) => key.includes(`"source_id":"${sourceId}"`)).length;
  }

  private providerFailure(
    info: DataSourceInfo,
    error: string,
    startedAt: number,
    attemptCount: number
  ): DataProviderResult<ProviderFundPayload> {
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
      warnings: ["Provider 调度层未收到返回结果。"],
      error,
      is_demo: info.is_demo,
      attempt_count: attemptCount,
      latency_ms: Date.now() - startedAt,
      cache_hit: false,
      cache_expires_at: null,
      skipped_by_circuit_breaker: false
    };
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
    requirement: DataRequirement | "official_current_nav" | "official_nav_history" | "official_fund_reports" | "benchmark",
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

  private mergeContext(left: ProviderFundPayload, right: ProviderFundPayload): ProviderFundPayload {
    return {
      ...left,
      ...Object.fromEntries(Object.entries(right).filter(([, value]) => value !== undefined && value !== null)),
      nav_history: right.nav_history?.length ? right.nav_history : left.nav_history,
      nav_history_dates: right.nav_history_dates?.length ? right.nav_history_dates : left.nav_history_dates,
      portfolio_holdings: [...new Set([...(left.portfolio_holdings ?? []), ...(right.portfolio_holdings ?? [])])],
      fund_report_refs: [...new Set([...(left.fund_report_refs ?? []), ...(right.fund_report_refs ?? [])])],
      fund_report_documents: [...(left.fund_report_documents ?? []), ...(right.fund_report_documents ?? [])],
      themes: [...new Set([...(left.themes ?? []), ...(right.themes ?? [])])],
      policy_signals: [...new Set([...(left.policy_signals ?? []), ...(right.policy_signals ?? [])])],
      macro_indicators: this.mergeMacroIndicators(left.macro_indicators, right.macro_indicators),
      news_summaries: [...new Set([...(left.news_summaries ?? []), ...(right.news_summaries ?? [])])],
      stage_returns: { ...(left.stage_returns ?? {}), ...(right.stage_returns ?? {}) }
    };
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
