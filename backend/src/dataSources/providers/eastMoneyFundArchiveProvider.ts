import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export class EastMoneyFundArchiveProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "eastmoney-fund-archive",
      source_name: "EastMoney Fund Archive Provider",
      source_type: "holdings",
      trust_level: "B",
      enabled: true,
      priority: 12,
      access_method: "public web endpoint: https://fundf10.eastmoney.com/FundArchivesDatas.aspx",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      freshness_policy: "holdings are acceptable when they match the latest disclosed quarterly report",
      notes: "Fetches public Tiantian/EastMoney fund archive pages for stock and bond holding tables."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["holdings", "fund_reports"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const stockUrl = this.urlFor("jjcc", input.fund_code);
    const bondUrl = this.urlFor("zqcc", input.fund_code);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const [stockResponse, bondResponse] = await Promise.all([
        this.fetchImpl(stockUrl, { signal: controller.signal, headers: this.headers(input.fund_code) }),
        this.fetchImpl(bondUrl, { signal: controller.signal, headers: this.headers(input.fund_code) })
      ]);
      const warnings: string[] = ["持仓数据来自公开页面披露片段，应与基金公司公告/定期报告交叉验证。"];
      const holdings: string[] = [];
      const asOfDates: string[] = [];
      let fundName: string | undefined;
      for (const [kind, response] of [
        ["stock", stockResponse],
        ["bond", bondResponse]
      ] as const) {
        if (!response.ok) {
          warnings.push(`${kind} holdings request returned HTTP ${response.status}.`);
          continue;
        }
        const text = await response.text();
        const parsed = EastMoneyFundArchiveProvider.parseArchiveData(text, kind);
        if (parsed.fundName) fundName = parsed.fundName;
        holdings.push(...parsed.holdings);
        if (parsed.asOfDate) asOfDates.push(parsed.asOfDate);
        if (!parsed.holdings.length) warnings.push(`${kind} holdings table was empty or could not be parsed.`);
      }

      if (!holdings.length) {
        return this.failure(info, "No holdings parsed from EastMoney archive", warnings, stockUrl);
      }

      const latestAsOf = asOfDates.sort().at(-1);
      const freshness = this.freshnessFor(latestAsOf);
      if (freshness === "stale") warnings.push("持仓披露日期较旧，Logos 必须降级。");
      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          fund_name: fundName,
          portfolio_holdings: [...new Set(holdings)],
          holdings_as_of: latestAsOf,
          holdings_source: "EastMoney/Tiantian Fund public archive"
        },
        raw_reference: stockUrl,
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
        ["东方财富/天天基金持仓档案抓取失败，Argus 应保留缺口并尝试官方报告 provider。"],
        stockUrl
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  static parseArchiveData(text: string, kind: "stock" | "bond"): { fundName?: string; asOfDate?: string; holdings: string[] } {
    const content = this.extractContent(text);
    const fundName = /<a[^>]*href=['"]http:\/\/fund\.eastmoney\.com\/\d+\.html['"][^>]*>([^<]+)<\/a>/u.exec(content)?.[1];
    const asOfDate = /截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/u.exec(content)?.[1];
    const rows = [...content.matchAll(/<tr>(.*?)<\/tr>/gu)].map((match) => match[1]);
    const holdings: string[] = [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gu)].map((match) => this.stripHtml(match[1]));
      if (kind === "stock" && cells.length >= 3 && /^\d{6}$/.test(cells[1])) {
        holdings.push(`stock:${cells[1]}:${cells[2]}`);
      }
      if (kind === "bond" && cells.length >= 3 && /^\d/.test(cells[1])) {
        holdings.push(`bond:${cells[1]}:${cells[2]}`);
      }
    }
    return { fundName, asOfDate, holdings };
  }

  private urlFor(type: "jjcc" | "zqcc", fundCode: string): string {
    return `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=${type}&code=${fundCode}&topline=10&year=&month=`;
  }

  private headers(fundCode: string): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: `https://fundf10.eastmoney.com/ccmx_${fundCode}.html`
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

  private freshnessFor(asOfDate?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!asOfDate) return "unknown";
    const ageDays = (Date.now() - new Date(`${asOfDate}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 120) return "fresh";
    if (ageDays <= 220) return "acceptable";
    return "stale";
  }

  private static extractContent(text: string): string {
    const match = /content:"([\s\S]*)",?arryear:/u.exec(text) ?? /content:"([\s\S]*)"\s*\}/u.exec(text);
    if (!match) return text;
    return match[1].replace(/\\"/g, '"').replace(/\\\//g, "/");
  }

  private static stripHtml(value: string): string {
    return value.replace(/<[^>]+>/gu, "").replace(/&nbsp;/gu, " ").trim();
  }
}
