import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface OecdCliSeriesConfig {
  country: string;
  countryName?: string;
}

interface OecdCsvRow {
  refArea: string;
  countryName: string;
  indicatorId: string;
  indicatorName: string;
  unit: string | null;
  date: string;
  value: number;
  sourceUrl: string;
}

const DEFAULT_COUNTRIES: OecdCliSeriesConfig[] = [
  { country: "USA", countryName: "United States" },
  { country: "CHN", countryName: "China (People's Republic of)" },
  { country: "JPN", countryName: "Japan" },
  { country: "GBR", countryName: "United Kingdom" },
  { country: "DEU", countryName: "Germany" },
  { country: "FRA", countryName: "France" }
];

export class OecdCliProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI";
  private static readonly cliKeySuffix = "M.LI.IX._Z.AA.IX._Z.H.";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly countries = OecdCliProvider.parseCountryList(process.env.FUNDSENTINEL_OECD_CLI_COUNTRIES, DEFAULT_COUNTRIES),
    private readonly startPeriod = process.env.FUNDSENTINEL_OECD_CLI_START_PERIOD ?? OecdCliProvider.defaultStartPeriod()
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "oecd-data-api",
      source_name: "OECD SDMX Composite Leading Indicator Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 56,
      access_method: "official OECD SDMX CSV API: https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI/{series}?format=csvfilewithlabels",
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
      freshness_policy: "monthly OECD CLI observations should be fresh within 4 months and acceptable within 8 months",
      notes:
        "Fetches official OECD SDMX monthly Composite Leading Indicator rows for global/QDII macro context. It does not provide fund NAV, holdings, report evidence, or investment advice."
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

    for (const country of this.countries) {
      const url = this.seriesUrl(country.country);
      lastReference = url;
      try {
        const response = await this.fetchWithTimeout(url);
        const text = await response.text();
        if (!response.ok) {
          failures.push(`${country.country} HTTP ${response.status}`);
          warnings.push(`OECD 官方 SDMX API 返回 HTTP ${response.status}，${country.country} CLI 无法自动获取。`);
          continue;
        }
        const rows = OecdCliProvider.parseCsvResponse(text, url).filter((row) => row.refArea.toUpperCase() === country.country.toUpperCase());
        const latest = OecdCliProvider.latestRow(rows);
        if (!latest) {
          failures.push(`${country.country} no observations`);
          warnings.push(`OECD 官方 SDMX API 未返回 ${country.country} 的可用 CLI 观测值。`);
          continue;
        }
        indicators.push({
          country_code: latest.refArea,
          country_name: country.countryName ?? latest.countryName,
          indicator_id: latest.indicatorId,
          indicator_name: latest.indicatorName,
          value: latest.value,
          date: latest.date,
          unit: latest.unit,
          source_url: latest.sourceUrl,
          source_name: "OECD SDMX",
          fetched_at: fetchedAt
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${country.country} ${message}`);
        warnings.push(`OECD SDMX provider 抓取 ${country.country} CLI 失败：${message}。`);
      }
    }

    if (!indicators.length) {
      return this.failure(
        info,
        failures.length ? failures.join(" | ") : "No usable OECD CLI observations returned",
        [
          ...warnings,
          "OECD 官方 SDMX API 未返回可用 CLI 指标；Argus 应保留 macro_data 缺口并尝试 IMF/World Bank/FRED/Eurostat 等备用宏观 provider。"
        ],
        lastReference ?? OecdCliProvider.baseUrl
      );
    }

    const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
    const freshness = this.freshnessFor(latestDate);
    const resultWarnings = [
      ...warnings,
      "OECD CLI 是官方短期宏观领先指标，只能辅助 Logos/Atlas 判断全球环境，不代表单只基金投资结论。",
      "OECD CLI 不可替代基金净值、持仓、定期报告或交易信号。"
    ];
    if (freshness === "stale") resultWarnings.push("OECD CLI 最新月度数据偏旧，后续硬逻辑判断必须降级。");

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
      raw_reference: OecdCliProvider.baseUrl,
      fetched_at: fetchedAt,
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseCsvResponse(text: string, sourceUrl = OecdCliProvider.baseUrl): OecdCsvRow[] {
    const records = this.parseCsv(text);
    if (records.length < 2) return [];
    const headers = records[0] ?? [];
    const index = (name: string) => headers.indexOf(name);
    const refAreaIndex = index("REF_AREA");
    const countryNameIndex = index("Reference area");
    const measureIndex = index("MEASURE");
    const measureNameIndex = index("Measure");
    const unitIndex = index("UNIT_MEASURE");
    const unitNameIndex = index("Unit of measure");
    const timeIndex = index("TIME_PERIOD");
    const valueIndex = index("OBS_VALUE");
    if ([refAreaIndex, countryNameIndex, measureIndex, measureNameIndex, timeIndex, valueIndex].some((item) => item < 0)) return [];

    return records.slice(1).flatMap((record) => {
      const value = OecdCliProvider.numericValueFor(record[valueIndex]);
      const date = record[timeIndex] ?? "";
      const refArea = record[refAreaIndex] ?? "";
      const indicatorId = record[measureIndex] ?? "";
      if (!refArea || !indicatorId || !/^\d{4}-\d{2}$/u.test(date) || !Number.isFinite(value)) return [];
      return [
        {
          refArea,
          countryName: record[countryNameIndex] ?? refArea,
          indicatorId: `OECD_CLI_${indicatorId}`,
          indicatorName: record[measureNameIndex] ?? "Composite leading indicator (CLI)",
          unit: record[unitNameIndex] ?? record[unitIndex] ?? null,
          date,
          value,
          sourceUrl
        }
      ];
    });
  }

  private seriesUrl(country: string): string {
    const params = new URLSearchParams({
      startPeriod: this.startPeriod,
      dimensionAtObservation: "AllDimensions",
      format: "csvfilewithlabels"
    });
    return `${OecdCliProvider.baseUrl}/${encodeURIComponent(country)}.${OecdCliProvider.cliKeySuffix}?${params.toString()}`;
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
      accept: "application/vnd.sdmx.data+csv,text/csv,text/plain,*/*"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date || !/^\d{4}-\d{2}$/u.test(date)) return "unknown";
    const ageMonths = this.monthAgeFor(date);
    if (ageMonths <= 4) return "fresh";
    if (ageMonths <= 8) return "acceptable";
    return "stale";
  }

  private monthAgeFor(date: string): number {
    const [year, month] = date.split("-").map(Number);
    const now = new Date();
    return (now.getUTCFullYear() - (year ?? now.getUTCFullYear())) * 12 + (now.getUTCMonth() + 1 - (month ?? now.getUTCMonth() + 1));
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

  private static latestRow(rows: OecdCsvRow[]): OecdCsvRow | null {
    return [...rows].sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  }

  private static parseCountryList(value: string | undefined, fallback: OecdCliSeriesConfig[]): OecdCliSeriesConfig[] {
    const items = value?.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
    if (!items?.length) return fallback;
    return items.map((country) => ({ country, countryName: fallback.find((item) => item.country === country)?.countryName }));
  }

  private static defaultStartPeriod(): string {
    const now = new Date();
    const year = now.getUTCFullYear() - 1;
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  private static parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (char === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(field);
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    row.push(field);
    if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    return rows;
  }

  private static numericValueFor(value: string | undefined): number {
    if (!value || value.trim() === "") return Number.NaN;
    return Number(value.replace(/,/gu, ""));
  }
}
