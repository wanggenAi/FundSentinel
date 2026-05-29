import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface EurostatSeriesConfig {
  dataset: string;
  indicator_id: string;
  indicator_name: string;
  unit: string | null;
  geo: string;
  query: Record<string, string>;
}

interface JsonStatDimension {
  label?: string;
  category?: {
    index?: Record<string, number>;
    label?: Record<string, string>;
  };
}

interface EurostatJsonStatResponse {
  label?: string;
  updated?: string;
  value?: Record<string, number | string | null | undefined>;
  id?: string[];
  size?: number[];
  dimension?: Record<string, JsonStatDimension>;
  error?: Array<{ status?: number; label?: string }>;
}

const DEFAULT_SERIES: EurostatSeriesConfig[] = [
  {
    dataset: "tec00115",
    indicator_id: "EU_REAL_GDP_GROWTH",
    indicator_name: "Real GDP growth rate - volume",
    unit: "percent change on previous period",
    geo: "EU27_2020",
    query: {
      geo: "EU27_2020",
      unit: "CLV_PCH_PRE",
      na_item: "B1GQ"
    }
  },
  {
    dataset: "une_rt_a",
    indicator_id: "EA_UNEMPLOYMENT_RATE",
    indicator_name: "Unemployment by sex and age - annual data",
    unit: "percent of labour force",
    geo: "EA20",
    query: {
      geo: "EA20",
      sex: "T",
      age: "Y15-74",
      unit: "PC_ACT"
    }
  }
];

export class EurostatProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly series = DEFAULT_SERIES,
    private readonly periods = EurostatProvider.defaultPeriods()
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "eurostat-api",
      source_name: "Eurostat Statistics API Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 57,
      access_method: "official Eurostat Statistics API: https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}",
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
      freshness_policy: "annual Eurostat macro series should be fresh within 18 months and acceptable within 30 months",
      notes: "Fetches official Eurostat JSON-stat macro indicators for EU/euro-area context. Fund NAV, holdings, and reports remain separate requirements."
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

    for (const config of this.series) {
      const url = this.seriesUrl(config);
      lastReference = url;
      try {
        const response = await this.fetchWithTimeout(url);
        const text = await response.text();
        if (!response.ok) {
          failures.push(`${config.dataset} HTTP ${response.status}`);
          warnings.push(`Eurostat 官方 API 返回 HTTP ${response.status}，数据集 ${config.dataset} 无法自动获取。`);
          continue;
        }
        indicators.push(...EurostatProvider.parseJsonStatResponse(text, config, fetchedAt, url));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${config.dataset} ${message}`);
        warnings.push(`Eurostat provider 抓取失败：${message}。`);
      }
    }

    if (!indicators.length) {
      return this.failure(
        info,
        failures.length ? failures.join(" | ") : "No usable Eurostat macro observations returned",
        [
          ...warnings,
          "Eurostat 官方宏观 API 未返回可用指标；Argus 应保留 macro_data 缺口并尝试 IMF/World Bank/OECD 等备用宏观 provider。"
        ],
        lastReference ?? EurostatProvider.baseUrl
      );
    }

    const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
    const freshness = this.freshnessFor(latestDate);
    const resultWarnings = [
      ...warnings,
      "Eurostat 指标是欧盟官方宏观背景，只能辅助 Logos/Atlas 判断环境，不代表单只基金投资结论。",
      "Eurostat 指标不可替代基金净值、持仓、定期报告等核心基金证据。"
    ];
    if (freshness === "stale") resultWarnings.push("Eurostat 宏观指标最新年份偏旧，后续硬逻辑判断必须降级。");

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
      raw_reference: EurostatProvider.baseUrl,
      fetched_at: fetchedAt,
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseJsonStatResponse(
    text: string,
    config: EurostatSeriesConfig,
    fetchedAt = nowIso(),
    sourceUrl = EurostatProvider.baseUrl
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const parsed = JSON.parse(text) as EurostatJsonStatResponse;
    if (parsed.error?.length) throw new Error(parsed.error.map((item) => item.label ?? `Eurostat error ${item.status ?? "unknown"}`).join(" | "));
    const timeIndex = parsed.dimension?.time?.category?.index ?? {};
    const geoLabel = parsed.dimension?.geo?.category?.label?.[config.geo] ?? EurostatProvider.geoNameFor(config.geo);
    const latest = Object.entries(timeIndex)
      .map(([date, dimensionIndex]) => ({
        date,
        value: EurostatProvider.numericValueFor(parsed.value?.[String(EurostatProvider.flatIndexFor(parsed, "time", dimensionIndex))])
      }))
      .filter((item) => /^\d{4}$/u.test(item.date) && Number.isFinite(item.value))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) return [];

    return [
      {
        country_code: config.geo,
        country_name: geoLabel,
        indicator_id: config.indicator_id,
        indicator_name: parsed.label ?? config.indicator_name,
        value: latest.value,
        date: latest.date,
        unit: config.unit,
        source_url: sourceUrl,
        source_name: "Eurostat",
        fetched_at: fetchedAt
      }
    ];
  }

  private seriesUrl(config: EurostatSeriesConfig): string {
    const params = new URLSearchParams({
      format: "JSON",
      lang: "en",
      ...config.query,
      sinceTimePeriod: this.periods[0] ?? "",
      untilTimePeriod: this.periods.at(-1) ?? ""
    });
    return `${EurostatProvider.baseUrl}/${encodeURIComponent(config.dataset)}?${params.toString()}`;
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

  private static flatIndexFor(parsed: EurostatJsonStatResponse, targetDimension: string, targetIndex: number): number {
    const ids = parsed.id ?? [];
    const sizes = parsed.size ?? [];
    const dimensionPosition = ids.indexOf(targetDimension);
    if (dimensionPosition === -1) return targetIndex;

    let multiplier = 1;
    for (let position = dimensionPosition + 1; position < sizes.length; position += 1) {
      multiplier *= sizes[position] ?? 1;
    }
    return targetIndex * multiplier;
  }

  private static defaultPeriods(): string[] {
    const currentYear = new Date().getUTCFullYear();
    return [currentYear - 1, currentYear].map(String);
  }

  private static geoNameFor(geo: string): string {
    const names: Record<string, string> = {
      EU27_2020: "European Union - 27 countries",
      EA20: "Euro area - 20 countries"
    };
    return names[geo] ?? geo;
  }

  private static numericValueFor(value: number | string | null | undefined): number {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return Number.NaN;
  }
}
