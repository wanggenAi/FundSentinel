import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface WorldBankIndicatorConfig {
  id: string;
  name: string;
  unit: string | null;
}

interface WorldBankObservation {
  date?: string;
  value?: number | null;
  country?: {
    id?: string;
    value?: string;
  };
  indicator?: {
    id?: string;
    value?: string;
  };
}

const DEFAULT_COUNTRIES = ["CN", "US", "EUU"];
const DEFAULT_INDICATORS: WorldBankIndicatorConfig[] = [
  { id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" },
  { id: "FP.CPI.TOTL.ZG", name: "Inflation, consumer prices (annual %)", unit: "percent" },
  { id: "FR.INR.RINR", name: "Real interest rate (%)", unit: "percent" }
];

export class WorldBankMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly countries = WorldBankMacroProvider.parseList(process.env.FUNDSENTINEL_WORLDBANK_COUNTRIES, DEFAULT_COUNTRIES),
    private readonly indicators = DEFAULT_INDICATORS
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "world-bank-api",
      source_name: "World Bank Open Data Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 54,
      access_method: "official World Bank API: https://api.worldbank.org/v2/country/{country}/indicator/{indicator}?format=json",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      consecutive_failure_count: 0,
      last_latency_ms: null,
      last_attempt_count: 0,
      cache_hit_count: 0,
      last_cache_hit_at: null,
      circuit_open_until: null,
      circuit_open_count: 0,
      freshness_policy: "annual macro indicators should be fresh within 18 months and acceptable within 30 months",
      notes: "Fetches official World Bank macro indicators for broad country/global context. It does not provide fund NAV or investment advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const fetchedAt = nowIso();
    try {
      const indicators = (
        await Promise.all(
          this.countries.flatMap((country) =>
            this.indicators.map(async (indicator) => this.fetchLatestIndicator(country, indicator, fetchedAt))
          )
        )
      ).filter((item) => item !== null);

      if (!indicators.length) {
        return this.failure(info, "No usable World Bank macro observations returned", ["World Bank API 未返回可用宏观指标。"], this.baseUrl());
      }

      const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "World Bank 宏观指标是官方宏观背景，只能辅助 Logos/Atlas 判断环境，不代表单只基金投资结论。",
        "World Bank 指标为年度/低频数据，不可替代基金净值、持仓、定期报告或交易信号。"
      ];
      if (freshness === "stale") warnings.push("World Bank 宏观指标最新年份偏旧，后续硬逻辑判断必须降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          macro_indicators: indicators
        },
        raw_reference: this.baseUrl(),
        fetched_at: fetchedAt,
        freshness,
        warnings,
        error: null,
        is_demo: false
      };
    } catch (error) {
      return this.failure(
        info,
        error instanceof Error ? error.message : String(error),
        ["World Bank 官方宏观 API 获取失败，Argus 应保留 macro_data 缺口并尝试 IMF/OECD/Eurostat/FRED 等备用宏观 provider。"],
        this.baseUrl()
      );
    }
  }

  static parseIndicatorResponse(
    text: string,
    fallbackConfig: WorldBankIndicatorConfig,
    fetchedAt = nowIso(),
    sourceUrl = "world-bank-test"
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    return parsed[1]
      .filter((item): item is WorldBankObservation => typeof item === "object" && item !== null)
      .filter((item) => Number.isFinite(item.value))
      .map((item) => ({
        country_code: item.country?.id ?? "unknown",
        country_name: item.country?.value ?? "unknown",
        indicator_id: item.indicator?.id ?? fallbackConfig.id,
        indicator_name: item.indicator?.value ?? fallbackConfig.name,
        value: Number(item.value),
        date: item.date ?? "unknown",
        unit: fallbackConfig.unit,
        source_url: sourceUrl,
        source_name: "World Bank Open Data",
        fetched_at: fetchedAt
      }));
  }

  private async fetchLatestIndicator(country: string, indicator: WorldBankIndicatorConfig, fetchedAt: string): Promise<NonNullable<ProviderFundPayload["macro_indicators"]>[number] | null> {
    const url = this.indicatorUrl(country, indicator.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: this.headers() });
      if (!response.ok) return null;
      const parsed = WorldBankMacroProvider.parseIndicatorResponse(await response.text(), indicator, fetchedAt, url);
      return parsed.find((item) => item.date !== "unknown") ?? parsed[0] ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private indicatorUrl(country: string, indicatorId: string): string {
    return `${this.baseUrl()}/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(indicatorId)}?format=json&per_page=8&MRV=1`;
  }

  private baseUrl(): string {
    return "https://api.worldbank.org/v2";
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date || !/^\d{4}$/u.test(date)) return "unknown";
    const year = Number(date);
    const currentYear = new Date().getUTCFullYear();
    const ageYears = currentYear - year;
    if (ageYears <= 1) return "fresh";
    if (ageYears <= 2) return "acceptable";
    return "stale";
  }

  private failure(info: DataSourceInfo, error: string, warnings: string[], rawReference: string | null = null): DataProviderResult<ProviderFundPayload> {
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
      warnings,
      error,
      is_demo: false
    };
  }

  private static parseList(value: string | undefined, fallback: string[]): string[] {
    return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? fallback;
  }
}
