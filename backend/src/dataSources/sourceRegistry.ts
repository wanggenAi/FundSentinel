import { CninfoReportProvider } from "./providers/cninfoReportProvider.js";
import { CmfChinaFundOfficialProvider } from "./providers/cmfChinaFundOfficialProvider.js";
import { DemoFixtureProvider } from "./providers/demoFixtureProvider.js";
import { EastMoneyFundAnnouncementProvider } from "./providers/eastMoneyFundAnnouncementProvider.js";
import { EastMoneyFundArchiveProvider } from "./providers/eastMoneyFundArchiveProvider.js";
import { EastMoneyFundProvider } from "./providers/eastMoneyFundProvider.js";
import { FundCompanyReportProvider } from "./providers/fundCompanyReportProvider.js";
import { GovCnPolicyProvider } from "./providers/govCnPolicyProvider.js";
import { ManualCsvProvider } from "./providers/manualCsvProvider.js";
import { PolicyNewsProvider } from "./providers/policyNewsProvider.js";
import type { DataProvider } from "./providers/baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "./sourceTypes.js";
import { listDataSourceCatalog } from "./sourceCatalog.js";
import { nowIso } from "../schemas/index.js";

export interface SourceRegistryOptions {
  demoMode?: boolean;
  enableLiveProviders?: boolean;
  providers?: Array<DataProvider<FundDataSourceInput, ProviderFundPayload>>;
}

export class SourceRegistry {
  private readonly providers: Array<DataProvider<FundDataSourceInput, ProviderFundPayload>>;
  private readonly sourceStates = new Map<string, DataSourceInfo>();
  private readonly demoMode: boolean;
  private readonly enableLiveProviders: boolean;
  private readonly usesCustomProviders: boolean;

  constructor(options: boolean | SourceRegistryOptions = {}) {
    const normalized: SourceRegistryOptions = typeof options === "boolean" ? { demoMode: options } : options;
    this.demoMode = normalized.demoMode ?? process.env.FUNDSENTINEL_DEMO_MODE === "true";
    this.enableLiveProviders =
      normalized.enableLiveProviders ?? (process.env.FUNDSENTINEL_DISABLE_LIVE_PROVIDERS !== "true" && process.env.NODE_ENV !== "test");
    this.usesCustomProviders = Boolean(normalized.providers);
    this.providers = normalized.providers ?? [
      new EastMoneyFundProvider(),
      new EastMoneyFundArchiveProvider(),
      new EastMoneyFundAnnouncementProvider(),
      new CmfChinaFundOfficialProvider(),
      new FundCompanyReportProvider(),
      new CninfoReportProvider(),
      new GovCnPolicyProvider(),
      new PolicyNewsProvider(),
      new ManualCsvProvider(),
      new DemoFixtureProvider()
    ];
    for (const provider of this.providers) {
      const info = provider.sourceInfo();
      this.sourceStates.set(info.source_id, {
        ...info,
        enabled: this.enabledFor(info)
      });
    }
  }

  listSources(): DataSourceInfo[] {
    return [...this.sourceStates.values()].sort((a, b) => a.priority - b.priority);
  }

  health(): Array<DataSourceInfo & { health_status: "healthy" | "disabled" | "failing" | "demo_only" }> {
    return this.listSources().map((source) => ({
      ...source,
      health_status: source.is_demo ? "demo_only" : source.enabled ? (source.failure_count > 0 ? "failing" : "healthy") : "disabled"
    }));
  }

  catalog() {
    return listDataSourceCatalog();
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
        return info.enabled && provider.canHandle({ ...input, demo_mode: this.demoMode });
      })
      .sort((a, b) => this.sourceStates.get(a.sourceInfo().source_id)!.priority - this.sourceStates.get(b.sourceInfo().source_id)!.priority);

    const results: Array<DataProviderResult<ProviderFundPayload>> = [];
    let context: ProviderFundPayload = {};
    for (const provider of activeProviders) {
      const result = await provider.fetch({ ...input, context, demo_mode: this.demoMode });
      this.recordResult(result);
      results.push(result);
      if (result.success && result.data) context = this.mergeContext(context, result.data);
    }
    return results;
  }

  recordResult(result: DataProviderResult<ProviderFundPayload>): void {
    const current = this.sourceStates.get(result.source_id);
    if (!current) return;
    this.sourceStates.set(result.source_id, {
      ...current,
      last_success_at: result.success ? nowIso() : current.last_success_at,
      last_failed_at: result.success ? current.last_failed_at : nowIso(),
      failure_count: result.success ? current.failure_count : current.failure_count + 1
    });
  }

  isDemoMode(): boolean {
    return this.demoMode;
  }

  private enabledFor(info: DataSourceInfo): boolean {
    if (info.is_demo) return this.demoMode;
    if (!this.usesCustomProviders && !this.enableLiveProviders) return false;
    return info.enabled;
  }

  private mergeContext(left: ProviderFundPayload, right: ProviderFundPayload): ProviderFundPayload {
    return {
      ...left,
      ...Object.fromEntries(Object.entries(right).filter(([, value]) => value !== undefined && value !== null)),
      nav_history: right.nav_history?.length ? right.nav_history : left.nav_history,
      portfolio_holdings: [...new Set([...(left.portfolio_holdings ?? []), ...(right.portfolio_holdings ?? [])])],
      fund_report_refs: [...new Set([...(left.fund_report_refs ?? []), ...(right.fund_report_refs ?? [])])],
      fund_report_documents: [...(left.fund_report_documents ?? []), ...(right.fund_report_documents ?? [])],
      themes: [...new Set([...(left.themes ?? []), ...(right.themes ?? [])])],
      policy_signals: [...new Set([...(left.policy_signals ?? []), ...(right.policy_signals ?? [])])],
      news_summaries: [...new Set([...(left.news_summaries ?? []), ...(right.news_summaries ?? [])])],
      stage_returns: { ...(left.stage_returns ?? {}), ...(right.stage_returns ?? {}) }
    };
  }
}
