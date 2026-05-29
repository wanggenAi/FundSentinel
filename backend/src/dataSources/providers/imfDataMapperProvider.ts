import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface ImfIndicatorConfig {
  id: string;
  name: string;
  unit: string | null;
}

interface ImfIndicatorMetadata {
  label?: string;
  unit?: string;
  source?: string;
  dataset?: string;
  "last-modified"?: string;
}

interface ImfDataMapperResponse {
  indicators?: Record<string, ImfIndicatorMetadata>;
  values?: Record<string, Record<string, Record<string, number | string | null | undefined>>>;
}

const DEFAULT_COUNTRIES = ["USA", "CHN", "EAQ", "JPN"];
const DEFAULT_INDICATORS: ImfIndicatorConfig[] = [
  { id: "NGDP_RPCH", name: "Real GDP growth", unit: "Annual percent change" },
  { id: "PCPIPCH", name: "Inflation rate, average consumer prices", unit: "Annual percent change" },
  { id: "LUR", name: "Unemployment rate", unit: "Percent of total labor force" }
];

export class ImfDataMapperProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.imf.org/external/datamapper/api/v2";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly countries = ImfDataMapperProvider.parseList(process.env.FUNDSENTINEL_IMF_COUNTRIES, DEFAULT_COUNTRIES),
    private readonly indicators = DEFAULT_INDICATORS,
    private readonly periods = ImfDataMapperProvider.defaultPeriods()
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "imf-data-api",
      source_name: "IMF DataMapper Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 55,
      access_method: "official IMF DataMapper API: https://www.imf.org/external/datamapper/api/v2/{indicator}/{country}",
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
      freshness_policy: "World Economic Outlook macro series should be fresh within 18 months and acceptable within 30 months",
      notes: "Fetches official IMF DataMapper macro indicators for global/QDII context. Fund NAV, holdings, and reports remain separate requirements."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const fetchedAt = nowIso();
    const indicators: NonNullable<ProviderFundPayload["macro_indicators"]> = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    let lastReference: string | null = null;

    for (const indicator of this.indicators) {
      const url = this.indicatorUrl(indicator.id);
      lastReference = url;
      try {
        const response = await this.fetchWithTimeout(url);
        const text = await response.text();
        if (!response.ok) {
          failures.push(`${indicator.id} HTTP ${response.status}`);
          warnings.push(`IMF DataMapper 官方 API 返回 HTTP ${response.status}，该指标无法自动获取。`);
          continue;
        }
        indicators.push(...ImfDataMapperProvider.parseIndicatorResponse(text, indicator, this.countries, fetchedAt, url));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${indicator.id} ${message}`);
        warnings.push(`IMF DataMapper provider 抓取失败：${message}。`);
      }
    }

    if (!indicators.length) {
      return this.failure(
        info,
        failures.length ? failures.join(" | ") : "No usable IMF DataMapper macro observations returned",
        [
          ...warnings,
          "IMF 官方宏观 API 未返回可用指标；Argus 应保留 macro_data 缺口并尝试 World Bank/FRED/OECD/Eurostat 等备用宏观 provider。"
        ],
        lastReference ?? ImfDataMapperProvider.baseUrl
      );
    }

    const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
    const freshness = this.freshnessFor(latestDate);
    const resultWarnings = [
      ...warnings,
      "IMF DataMapper 指标是官方全球宏观背景，只能辅助 Logos/Atlas 判断环境，不代表单只基金投资结论。",
      "IMF 指标不可替代基金净值、持仓、定期报告等核心基金证据。"
    ];
    if (freshness === "stale") resultWarnings.push("IMF 宏观指标最新年份偏旧，后续硬逻辑判断必须降级。");

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
      raw_reference: ImfDataMapperProvider.baseUrl,
      fetched_at: fetchedAt,
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseIndicatorResponse(
    text: string,
    fallbackConfig: ImfIndicatorConfig,
    countries: string[] = DEFAULT_COUNTRIES,
    fetchedAt = nowIso(),
    sourceUrl = ImfDataMapperProvider.baseUrl
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const parsed = JSON.parse(text) as ImfDataMapperResponse;
    const countrySet = new Set(countries.map((country) => country.toUpperCase()));
    const valuesByCountry = parsed.values?.[fallbackConfig.id] ?? {};
    const metadata = parsed.indicators?.[fallbackConfig.id];
    const indicatorName = metadata?.label ?? fallbackConfig.name;
    const unit = metadata?.unit ?? fallbackConfig.unit;
    return Object.entries(valuesByCountry)
      .filter(([countryCode]) => countrySet.has(countryCode.toUpperCase()))
      .flatMap(([countryCode, valuesByYear]) => {
        const latest = Object.entries(valuesByYear)
          .map(([date, value]) => ({ date, value: ImfDataMapperProvider.numericValueFor(value) }))
          .filter((item) => /^\d{4}$/u.test(item.date) && Number.isFinite(item.value))
          .sort((a, b) => b.date.localeCompare(a.date))[0];
        if (!latest) return [];
        return [
          {
            country_code: countryCode,
            country_name: ImfDataMapperProvider.countryNameFor(countryCode),
            indicator_id: fallbackConfig.id,
            indicator_name: indicatorName,
            value: latest.value,
            date: latest.date,
            unit,
            source_url: sourceUrl,
            source_name: "IMF DataMapper",
            fetched_at: fetchedAt
          }
        ];
      });
  }

  private indicatorUrl(indicatorId: string): string {
    const countryPath = this.countries.map((country) => encodeURIComponent(country)).join("/");
    const params = new URLSearchParams({ periods: this.periods.join(",") });
    return `${ImfDataMapperProvider.baseUrl}/${encodeURIComponent(indicatorId)}/${countryPath}?${params.toString()}`;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal, headers: this.headers() });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "application/json,text/plain,*/*"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date || !/^\d{4}$/u.test(date)) return "unknown";
    const currentYear = new Date().getUTCFullYear();
    const ageYears = currentYear - Number(date);
    if (ageYears <= 1) return "fresh";
    if (ageYears <= 2) return "acceptable";
    return "stale";
  }

  private failure(info: DataSourceInfo, error: string, warnings: string[], rawReference: string | null): DataProviderResult<ProviderFundPayload> {
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

  private static defaultPeriods(): string[] {
    const currentYear = new Date().getUTCFullYear();
    return [currentYear - 1, currentYear, currentYear + 1].map(String);
  }

  private static parseList(value: string | undefined, fallback: string[]): string[] {
    return value?.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean) ?? fallback;
  }

  private static countryNameFor(countryCode: string): string {
    const names: Record<string, string> = {
      USA: "United States",
      CHN: "China",
      EAQ: "Euro area",
      JPN: "Japan",
      GBR: "United Kingdom",
      DEU: "Germany",
      FRA: "France"
    };
    return names[countryCode.toUpperCase()] ?? countryCode;
  }

  private static numericValueFor(value: number | string | null | undefined): number {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return Number.NaN;
  }
}
