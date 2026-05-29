import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface AmacPublicFundReport {
  title: string;
  url: string;
  published_at: string | null;
  period: string | null;
  report_type: "public_fund_market_data";
}

const AMAC_PUBLIC_FUND_DATA_URL = "https://www.amac.org.cn/sjtj/tjbg/gmjj/";

export class AmacPublicFundDataProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly listUrl = AMAC_PUBLIC_FUND_DATA_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "amac-public-fund-data",
      source_name: "Asset Management Association of China Public Fund Data Provider",
      source_type: "policy",
      trust_level: "A",
      enabled: true,
      priority: 4,
      access_method: `official AMAC public fund statistics page: ${this.listUrl}`,
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
      freshness_policy: "official monthly public-fund market data should be fresh within 75 days and acceptable within 150 days",
      notes:
        "Fetches AMAC official public-fund market-data report references as industry baseline context. Fund NAV, holdings, and report bodies remain separate requirements."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const response = await this.fetchWithTimeout(this.listUrl);
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`基金业协会公募基金统计报告页面返回 HTTP ${response.status}。`], this.listUrl);
      }

      const reports = AmacPublicFundDataProvider.parseReportList(await response.text(), this.listUrl);
      if (!reports.length) {
        return this.failure(
          info,
          "No AMAC public fund market-data reports parsed",
          ["基金业协会公募基金统计报告页面未解析到公募基金市场数据 PDF。"],
          this.listUrl
        );
      }

      const selected = reports.slice(0, 6);
      const latestDate = reports.map((report) => report.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "中国证券投资基金业协会公募基金市场数据仅作为行业规模/结构背景证据，不能直接补齐单只基金核心证据。",
        "AMAC 行业统计不可替代基金净值、持仓或基金公司定期报告。"
      ];
      if (freshness === "stale") warnings.push("基金业协会公募基金市场数据最新发布日期偏旧，行业背景证据应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          policy_signals: selected.map(
            (report) => `${report.published_at ?? "unknown-date"} 基金业协会公募基金市场数据 ${report.period ?? report.title}`
          ),
          news_summaries: selected.map((report) => `中国证券投资基金业协会/公募基金统计：${report.title}（${report.published_at ?? "日期未知"}）`)
        },
        raw_reference: this.listUrl,
        fetched_at: nowIso(),
        freshness,
        warnings,
        error: null,
        is_demo: false
      };
    } catch (error) {
      return this.failure(
        info,
        error instanceof Error ? error.message : String(error),
        ["基金业协会公募基金统计报告抓取失败，Argus 应保留 policy_evidence/industry_news 缺口并尝试 Gov.cn、证监会、交易所或人工官方资料导入。"],
        this.listUrl
      );
    }
  }

  static parseReportList(html: string, pageUrl = AMAC_PUBLIC_FUND_DATA_URL): AmacPublicFundReport[] {
    const reports = new Map<string, AmacPublicFundReport>();
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
    for (const match of html.matchAll(anchorPattern)) {
      const attrs = match[1] ?? "";
      const title = this.cleanText(match[2] ?? "");
      const href = this.attributeValue(attrs, "href");
      if (!href || !/公募基金市场数据/u.test(title) || !/\.pdf(?:[?#].*)?$/iu.test(href)) continue;

      const url = this.resolveUrl(href, pageUrl);
      const nearbyHtml = html.slice(Math.max(0, match.index - 200), Math.min(html.length, match.index + (match[0]?.length ?? 0) + 200));
      const publishedAt = this.publishedDateFrom(nearbyHtml, url);
      const report = {
        title,
        url,
        published_at: publishedAt,
        period: this.periodFrom(title),
        report_type: "public_fund_market_data" as const
      };
      reports.set(`${report.period ?? report.title}|${report.url}`, report);
    }
    return [...reports.values()].sort((left, right) => (right.period ?? right.published_at ?? "").localeCompare(left.period ?? left.published_at ?? ""));
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
      referer: "https://www.amac.org.cn/",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    };
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

  private freshnessFor(date?: string | null): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 75) return "fresh";
    if (ageDays <= 150) return "acceptable";
    return "stale";
  }

  private static publishedDateFrom(html: string, url: string, shortDate?: string): string | null {
    const explicit = /(\d{4})[-年](\d{1,2})[-月](\d{1,2})/u.exec(html);
    if (explicit) return this.isoDate(explicit[1], explicit[2], explicit[3]);

    const yearMonth = /\/(20\d{2})(\d{2})\//u.exec(url);
    const short = /(\d{1,2})[-月](\d{1,2})/u.exec(shortDate ?? html);
    if (yearMonth && short) return this.isoDate(yearMonth[1], short[1], short[2]);
    return null;
  }

  private static periodFrom(title: string): string | null {
    const match = /公募基金市场数据[（(](\d{4})年(\d{1,2})月[）)]/u.exec(title);
    if (!match) return null;
    return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;
  }

  private static isoDate(year?: string, month?: string, day?: string): string | null {
    if (!year || !month || !day) return null;
    return `${year}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
  }

  private static cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/gu, "")
      .replace(/&nbsp;|&#32;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static attributeValue(attrs: string, name: string): string | null {
    const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(attrs);
    return match?.[1] ?? null;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
