import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface SafeOfficialReserveLink {
  title: string;
  html_url: string;
  year: number | null;
}

interface ReserveIndicatorConfig {
  id: string;
  name: string;
  labels: string[];
}

const SAFE_OFFICIAL_RESERVE_LIST_URL = "https://www.safe.gov.cn/safe/gfcbzc/index.html";
const SAFE_SOURCE_NAME = "State Administration of Foreign Exchange";

const RESERVE_INDICATORS: ReserveIndicatorConfig[] = [
  {
    id: "CN.SAFE.FX_RESERVES_USD",
    name: "Foreign currency reserves",
    labels: ["外汇储备", "Foreign currency reserves"]
  },
  {
    id: "CN.SAFE.IMF_RESERVE_POSITION_USD",
    name: "IMF reserve position",
    labels: ["基金组织储备头寸", "IMF reserve position"]
  },
  {
    id: "CN.SAFE.SDRS_USD",
    name: "Special drawing rights",
    labels: ["特别提款权", "SDRs"]
  },
  {
    id: "CN.SAFE.GOLD_RESERVES_USD",
    name: "Gold reserves",
    labels: ["黄金", "Gold"]
  },
  {
    id: "CN.SAFE.OTHER_RESERVE_ASSETS_USD",
    name: "Other reserve assets",
    labels: ["其他储备资产", "Other reserve assets"]
  },
  {
    id: "CN.SAFE.TOTAL_RESERVE_ASSETS_USD",
    name: "Total official reserve assets",
    labels: ["合计", "Total"]
  }
];

export class SafeMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly listUrl = SAFE_OFFICIAL_RESERVE_LIST_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "safe-official",
      source_name: "State Administration of Foreign Exchange Macro Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 46,
      access_method: `official SAFE reserve-assets HTML: ${this.listUrl}`,
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
      freshness_policy: "monthly SAFE reserve-assets data should be fresh within 75 days and acceptable within 150 days",
      notes:
        "Fetches official SAFE reserve-asset statistics from public HTML tables. It is cross-border macro context only, not fund NAV, holdings, or advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const listResponse = await this.fetchWithTimeout(this.listUrl);
      if (!listResponse.ok) {
        return this.failure(info, `HTTP ${listResponse.status}`, [`国家外汇管理局官方储备资产列表页返回 HTTP ${listResponse.status}。`], this.listUrl);
      }

      const link = SafeMacroProvider.parseOfficialReserveLink(await listResponse.text(), this.listUrl);
      if (!link) {
        return this.failure(info, "No SAFE official reserve-assets table link parsed", ["国家外汇管理局官方储备资产列表页未解析到年度 HTML 数据链接。"], this.listUrl);
      }

      const tableResponse = await this.fetchWithTimeout(link.html_url);
      if (!tableResponse.ok) {
        return this.failure(info, `HTTP ${tableResponse.status}`, [`国家外汇管理局官方储备资产 HTML 表返回 HTTP ${tableResponse.status}。`], link.html_url);
      }

      const fetchedAt = nowIso();
      const indicators = SafeMacroProvider.parseOfficialReserveTable(await tableResponse.text(), fetchedAt, link.html_url);
      if (!indicators.length) {
        return this.failure(info, "No usable SAFE reserve-assets observations parsed", ["国家外汇管理局官方储备资产表未解析到月度美元口径储备指标。"], link.html_url);
      }

      const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "国家外汇管理局官方储备资产统计是官方跨境宏观背景，只能辅助 Logos/Atlas 判断外汇与 QDII 环境，不代表单只基金投资结论。",
        "SAFE 储备资产统计不可替代基金净值、持仓、定期报告或交易信号。"
      ];
      if (freshness === "stale") warnings.push("国家外汇管理局官方储备资产最新月份偏旧，后续硬逻辑判断必须降级。");

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
        raw_reference: link.html_url,
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
        ["国家外汇管理局官方储备资产抓取失败，Argus 应保留 macro_data 缺口并尝试 PBC/StatsGov/World Bank/IMF/FRED 等备用宏观 provider。"],
        this.listUrl
      );
    }
  }

  static parseOfficialReserveLink(html: string, pageUrl = SAFE_OFFICIAL_RESERVE_LIST_URL): SafeOfficialReserveLink | null {
    const candidates = [...html.matchAll(/<a\s+([^>]*)>([\s\S]*?)<\/a>/giu)]
      .map((match) => {
        const attrs = match[1] ?? "";
        const href = SafeMacroProvider.attributeValue(attrs, "href");
        const title = SafeMacroProvider.attributeValue(attrs, "title") ?? SafeMacroProvider.stripHtml(match[2] ?? "");
        const normalizedTitle = SafeMacroProvider.stripHtml(title);
        return {
          href,
          title: normalizedTitle,
          year: SafeMacroProvider.yearFrom(normalizedTitle)
        };
      })
      .filter((candidate) => candidate.href && /官方储备资产/u.test(candidate.title) && !/国际储备与外币流动性/u.test(candidate.title))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

    const latest = candidates[0];
    if (!latest?.href) return null;
    return {
      title: latest.title,
      html_url: SafeMacroProvider.resolveUrl(latest.href, pageUrl),
      year: latest.year
    };
  }

  static parseOfficialReserveTable(
    html: string,
    fetchedAt = nowIso(),
    sourceUrl = "safe-official-reserve-test"
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const rows = SafeMacroProvider.extractRows(html);
    const monthRowIndex = rows.findIndex((row) => row.some((cell) => SafeMacroProvider.monthFrom(cell)));
    if (monthRowIndex < 0) return [];

    const months = rows[monthRowIndex]!.map((cell) => SafeMacroProvider.monthFrom(cell)).filter((month) => month !== null);
    if (!months.length) return [];

    const unitRow = rows[monthRowIndex + 1] ?? [];
    const usdUnitCount = unitRow.filter((cell) => /亿美元|100\s*million\s*USD/iu.test(cell)).length;
    const columnsPerMonth = usdUnitCount >= months.length ? Math.max(1, Math.round(unitRow.length / months.length)) : 1;

    return RESERVE_INDICATORS.flatMap((indicator) => {
      const row = rows.find((candidate) => SafeMacroProvider.matchesIndicator(candidate[0] ?? "", indicator));
      if (!row) return [];
      return months.flatMap((date, index) => {
        const cellIndex = 1 + index * columnsPerMonth;
        const value = SafeMacroProvider.numberValueFor(row[cellIndex] ?? "");
        if (!Number.isFinite(value)) return [];
        return {
          country_code: "CN",
          country_name: "China",
          indicator_id: indicator.id,
          indicator_name: indicator.name,
          value,
          date,
          unit: "100 million USD",
          source_url: sourceUrl,
          source_name: SAFE_SOURCE_NAME,
          fetched_at: fetchedAt
        };
      });
    });
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
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date || !/^\d{4}-\d{2}$/u.test(date)) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}-01T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 75) return "fresh";
    if (ageDays <= 150) return "acceptable";
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

  private static extractRows(html: string): string[][] {
    return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)]
      .map((rowMatch) =>
        [...rowMatch[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu)]
          .map((cellMatch) => SafeMacroProvider.stripHtml(cellMatch[1] ?? ""))
          .filter((cell) => cell !== "")
      )
      .filter((row) => row.length > 0);
  }

  private static matchesIndicator(cell: string, indicator: ReserveIndicatorConfig): boolean {
    const normalized = SafeMacroProvider.normalizeText(cell);
    return indicator.labels.some((label) => normalized.includes(SafeMacroProvider.normalizeText(label)));
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<script[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<span[^>]*mso-spacerun:yes[^>]*>[\s\S]*?<\/span>/giu, " ")
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&#39;/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static normalizeText(value: string): string {
    return SafeMacroProvider.stripHtml(value).replace(/\s+/gu, "").toLowerCase();
  }

  private static numberValueFor(value: string): number {
    return Number(value.replace(/,/gu, "").replace(/\s+/gu, ""));
  }

  private static monthFrom(value: string): string | null {
    const match = value.match(/(\d{4})[.\-年](\d{1,2})/u);
    if (!match) return null;
    return `${match[1]}-${match[2]!.padStart(2, "0")}`;
  }

  private static yearFrom(value: string): number | null {
    const year = Number(value.match(/(20\d{2}|19\d{2})/u)?.[1]);
    return Number.isFinite(year) ? year : null;
  }

  private static attributeValue(attrs: string, name: string): string | null {
    const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
    return match?.[1] ?? null;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
