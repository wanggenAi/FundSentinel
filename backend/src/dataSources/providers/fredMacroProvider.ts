import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface FredSeriesConfig {
  id: string;
  name: string;
  unit: string | null;
  country_code?: string;
  country_name?: string;
}

interface FredObservation {
  date?: string;
  value?: string;
}

interface FredObservationResponse {
  error_code?: number;
  error_message?: string;
  observations?: FredObservation[];
}

const DEFAULT_SERIES: FredSeriesConfig[] = [
  { id: "FEDFUNDS", name: "Effective Federal Funds Rate", unit: "percent", country_code: "US", country_name: "United States" },
  { id: "DGS10", name: "10-Year Treasury Constant Maturity Rate", unit: "percent", country_code: "US", country_name: "United States" },
  { id: "CPIAUCSL", name: "Consumer Price Index for All Urban Consumers", unit: "index", country_code: "US", country_name: "United States" },
  { id: "UNRATE", name: "Unemployment Rate", unit: "percent", country_code: "US", country_name: "United States" }
];

export class FredMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://api.stlouisfed.org/fred/series/observations";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly apiKey: string | undefined = process.env.FUNDSENTINEL_FRED_API_KEY ?? process.env.FRED_API_KEY,
    private readonly series = DEFAULT_SERIES
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "fred-official",
      source_name: "FRED Federal Reserve Economic Data Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 53,
      access_method: "official FRED API: https://api.stlouisfed.org/fred/series/observations",
      requires_auth: true,
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
      freshness_policy: "official FRED series should be fresh within 45 days and acceptable within 180 days, depending on release frequency",
      notes: "Fetches official US macro indicators for global risk context. Requires FRED_API_KEY or FUNDSENTINEL_FRED_API_KEY and never stores or returns the key."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const fetchedAt = nowIso();
    if (!this.apiKey?.trim()) {
      return this.failure(
        info,
        "Missing FRED API key",
        [
          "FRED_API_KEY / FUNDSENTINEL_FRED_API_KEY 未配置，FRED 官方宏观 provider 不参与自动数据获取。",
          "Argus 不会硬编码、伪造或用 demo 数据替代 FRED 官方数据；需要通过环境变量配置官方 API key。"
        ],
        FredMacroProvider.baseUrl
      );
    }

    const indicators: NonNullable<ProviderFundPayload["macro_indicators"]> = [];
    const failures: string[] = [];
    const warnings: string[] = [];

    for (const config of this.series) {
      try {
        const indicator = await this.fetchLatestSeries(config, fetchedAt);
        if (indicator) indicators.push(indicator);
        else {
          failures.push(`${config.id} no usable observation`);
          warnings.push(`FRED 官方序列 ${config.id} 未返回可用观测值。`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${config.id} ${message}`);
        warnings.push(`FRED 官方序列 ${config.id} 获取失败：${message}。`);
      }
    }

    if (!indicators.length) {
      return this.failure(
        info,
        failures.length ? failures.join(" | ") : "No usable FRED macro observations returned",
        [
          ...warnings,
          "FRED 官方宏观 API 未返回可用宏观指标；Argus 应保留 macro_data 缺口并尝试 World Bank/IMF/OECD/Eurostat 等备用宏观 provider。"
        ],
        FredMacroProvider.baseUrl
      );
    }

    const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
    const freshness = this.freshnessFor(latestDate);
    const resultWarnings = [
      ...warnings,
      "FRED 官方宏观指标只能作为美国利率、通胀、就业和全球风险背景，不代表单只基金投资结论。",
      "FRED 指标不可替代基金净值、持仓、定期报告等核心基金证据。"
    ];
    if (freshness === "stale") resultWarnings.push("FRED 宏观指标最新观测日期偏旧，后续硬逻辑判断必须降级。");

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
      raw_reference: FredMacroProvider.baseUrl,
      fetched_at: fetchedAt,
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseObservationsResponse(
    text: string,
    fallbackConfig: FredSeriesConfig,
    fetchedAt = nowIso(),
    sourceUrl = FredMacroProvider.baseUrl
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const parsed = JSON.parse(text) as FredObservationResponse;
    if (parsed.error_code) {
      throw new Error(`FRED API error ${parsed.error_code}: ${parsed.error_message ?? "unknown error"}`);
    }
    return (parsed.observations ?? [])
      .map((observation) => {
        const value = observation.value === undefined || observation.value === "." ? Number.NaN : Number(observation.value);
        if (!Number.isFinite(value) || !observation.date) return null;
        return {
          country_code: fallbackConfig.country_code ?? "US",
          country_name: fallbackConfig.country_name ?? "United States",
          indicator_id: fallbackConfig.id,
          indicator_name: fallbackConfig.name,
          value,
          date: observation.date,
          unit: fallbackConfig.unit,
          source_url: sourceUrl,
          source_name: "FRED Federal Reserve Economic Data",
          fetched_at: fetchedAt
        };
      })
      .filter((item) => item !== null);
  }

  private async fetchLatestSeries(
    config: FredSeriesConfig,
    fetchedAt: string
  ): Promise<NonNullable<ProviderFundPayload["macro_indicators"]>[number] | null> {
    const url = this.seriesUrl(config.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: this.headers() });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return FredMacroProvider.parseObservationsResponse(text, config, fetchedAt, this.sanitizedSeriesUrl(config.id))[0] ?? null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private seriesUrl(seriesId: string): string {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: this.apiKey ?? "",
      file_type: "json",
      sort_order: "desc",
      limit: "8"
    });
    return `${FredMacroProvider.baseUrl}?${params.toString()}`;
  }

  private sanitizedSeriesUrl(seriesId: string): string {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: "***",
      file_type: "json",
      sort_order: "desc",
      limit: "8"
    });
    return `${FredMacroProvider.baseUrl}?${params.toString()}`;
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "application/json,text/plain,*/*"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const timestamp = Date.parse(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp)) return "unknown";
    const ageDays = (Date.now() - timestamp) / 86_400_000;
    if (ageDays <= 45) return "fresh";
    if (ageDays <= 180) return "acceptable";
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
}
