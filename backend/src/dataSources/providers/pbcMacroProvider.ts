import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface PbcMoneySupplyLink {
  title: string;
  html_url: string;
  xls_url: string | null;
  pdf_url: string | null;
}

const PBC_MONEY_OVERVIEW_URL = "https://www.pbc.gov.cn/diaochatongjisi/116219/116319/5570903/5570886/index.html";

const MONEY_SUPPLY_INDICATORS = [
  { id: "CN.PBC.M2", name: "Money & Quasi-money (M2)", label: "Money & Quasi-money" },
  { id: "CN.PBC.M1", name: "Money (M1)", label: "Money" },
  { id: "CN.PBC.M0", name: "Currency in Circulation (M0)", label: "Currency in Circulation" }
];

export class PbcMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "pbc-official",
      source_name: "People's Bank of China Macro Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 43,
      access_method: `official PBC money statistics HTML: ${PBC_MONEY_OVERVIEW_URL}`,
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
      freshness_policy: "monthly PBC money supply data should be fresh within 75 days and acceptable within 150 days",
      notes: "Fetches official PBC money supply statistics from public HTML tables. It is macro/liquidity context only, not fund NAV or advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const overviewResponse = await this.fetchWithTimeout(PBC_MONEY_OVERVIEW_URL);
      if (!overviewResponse.ok) {
        return this.failure(info, `HTTP ${overviewResponse.status}`, [`中国人民银行货币统计概览页返回 HTTP ${overviewResponse.status}。`], PBC_MONEY_OVERVIEW_URL);
      }
      const overviewHtml = await overviewResponse.text();
      const moneySupplyLink = PbcMacroProvider.parseMoneySupplyLink(overviewHtml, PBC_MONEY_OVERVIEW_URL);
      if (!moneySupplyLink) {
        return this.failure(info, "No PBC Money Supply table link parsed", ["中国人民银行货币统计概览页未解析到货币供应量 htm 链接。"], PBC_MONEY_OVERVIEW_URL);
      }

      const tableResponse = await this.fetchWithTimeout(moneySupplyLink.html_url);
      if (!tableResponse.ok) {
        return this.failure(info, `HTTP ${tableResponse.status}`, [`中国人民银行货币供应量表返回 HTTP ${tableResponse.status}。`], moneySupplyLink.html_url);
      }
      const fetchedAt = nowIso();
      const indicators = PbcMacroProvider.parseMoneySupplyTable(await tableResponse.text(), fetchedAt, moneySupplyLink.html_url);
      if (!indicators.length) {
        return this.failure(info, "No usable PBC money supply observations parsed", ["中国人民银行货币供应量表未解析到 M2/M1/M0 月度指标。"], moneySupplyLink.html_url);
      }

      const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "中国人民银行货币供应量统计是官方宏观/流动性背景，只能辅助 Logos/Atlas 判断环境，不代表单只基金投资结论。",
        "PBC 货币统计不可替代基金净值、持仓、定期报告或交易信号。"
      ];
      if (freshness === "stale") warnings.push("中国人民银行货币供应量数据最新月份偏旧，后续硬逻辑判断必须降级。");

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
        raw_reference: moneySupplyLink.html_url,
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
        ["中国人民银行官方货币统计抓取失败，Argus 应保留 macro_data 缺口并尝试 StatsGov/World Bank/IMF/FRED 等备用宏观 provider。"],
        PBC_MONEY_OVERVIEW_URL
      );
    }
  }

  static parseMoneySupplyLink(html: string, pageUrl = PBC_MONEY_OVERVIEW_URL): PbcMoneySupplyLink | null {
    const tablePattern = /<table[^>]*class=["']a2015["'][\s\S]*?<\/table>/giu;
    for (const tableMatch of html.matchAll(tablePattern)) {
      const tableHtml = tableMatch[0];
      if (!/Money Supply|货币供应量/u.test(tableHtml)) continue;
      const links = [...tableHtml.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)].map((match) => ({
        href: match[1] ?? "",
        label: PbcMacroProvider.stripHtml(match[2] ?? "").toLowerCase()
      }));
      const htmlLink = links.find((link) => link.label.includes("htm"));
      if (!htmlLink) return null;
      return {
        title: "Money Supply",
        html_url: PbcMacroProvider.resolveUrl(htmlLink.href, pageUrl),
        xls_url: PbcMacroProvider.optionalUrl(links.find((link) => /xls|xlsx/u.test(link.label))?.href, pageUrl),
        pdf_url: PbcMacroProvider.optionalUrl(links.find((link) => link.label.includes("pdf"))?.href, pageUrl)
      };
    }
    return null;
  }

  static parseMoneySupplyTable(
    html: string,
    fetchedAt = nowIso(),
    sourceUrl = "pbc-money-supply-test"
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const rows = PbcMacroProvider.extractRows(html);
    const monthRowIndex = rows.findIndex((row) => row.some((cell) => /^\d{4}\.\d{2}$/u.test(cell)));
    if (monthRowIndex < 0) return [];
    const months = rows[monthRowIndex]!.filter((cell) => /^\d{4}\.\d{2}$/u.test(cell)).map((cell) => cell.replace(".", "-"));
    if (!months.length) return [];

    return MONEY_SUPPLY_INDICATORS.flatMap((indicator) => {
      const labelRowIndex = rows.findIndex((row) => row.some((cell) => cell.includes(indicator.label)));
      if (labelRowIndex <= 0) return [];
      const valueRow = rows[labelRowIndex - 1]!;
      const values = valueRow.map((cell) => PbcMacroProvider.numberValueFor(cell)).filter((value) => Number.isFinite(value));
      if (!values.length) return [];
      return months.slice(0, values.length).map((date, index) => ({
        country_code: "CN",
        country_name: "China",
        indicator_id: indicator.id,
        indicator_name: indicator.name,
        value: values[index]!,
        date,
        unit: "100 million yuan",
        source_url: sourceUrl,
        source_name: "People's Bank of China",
        fetched_at: fetchedAt
      }));
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
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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
        [...rowMatch[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/giu)]
          .map((cellMatch) => PbcMacroProvider.stripHtml(cellMatch[1] ?? ""))
          .filter((cell) => cell !== "")
      )
      .filter((row) => row.length > 0);
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<span[^>]*mso-spacerun:yes[^>]*>[\s\S]*?<\/span>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static numberValueFor(value: string): number {
    return Number(value.replace(/,/gu, "").trim());
  }

  private static optionalUrl(href: string | undefined, pageUrl: string): string | null {
    return href ? PbcMacroProvider.resolveUrl(href, pageUrl) : null;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
