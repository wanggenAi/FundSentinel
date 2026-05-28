import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface HuaAnNavRow {
  date: string;
  nav: number;
  accumulatedNav?: number;
  dailyReturn?: number;
}

interface HuaAnNotice {
  title: string;
  publishedAt: string | null;
  detailUrl: string;
}

export class HuaAnFundOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.huaan.com.cn";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "huaan-fund-official",
      source_name: "华安基金官网官方净值 Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 7,
      access_method: "official fund company website: https://www.huaan.com.cn/funds/{fund_code}/index.shtml and /funddetail/selectFundayByCode.do",
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
      freshness_policy: "official company NAV rows should be fresh within 10 days and acceptable within 30 days",
      notes: "Parses HuaAn official fund pages and NAV table endpoint for official fund metadata, current NAV, recent NAV rows, holdings names, and disclosure links."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history", "holdings", "fund_reports"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/u.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const detailUrl = this.fundDetailUrl(input.fund_code);
    const navUrl = this.navTableUrl(input.fund_code);
    try {
      const [detailResponse, navResponse] = await Promise.all([
        this.fetchWithTimeout(detailUrl, { headers: this.headers() }, this.timeoutMs),
        this.fetchWithTimeout(navUrl, { headers: { ...this.headers(), referer: detailUrl } }, this.timeoutMs)
      ]);

      if (!detailResponse.ok) return this.failure(info, `detail HTTP ${detailResponse.status}`, [`华安基金官网详情页返回 HTTP ${detailResponse.status}。`], detailUrl);
      if (!navResponse.ok) return this.failure(info, `nav table HTTP ${navResponse.status}`, [`华安基金官网净值表返回 HTTP ${navResponse.status}。`], navUrl);

      const detailHtml = await detailResponse.text();
      if (HuaAnFundOfficialProvider.isUnavailablePage(detailHtml)) {
        return this.failure(info, "Fund not found on HuaAn official website", ["华安基金官网未返回可验证的基金详情页。"], detailUrl);
      }
      const navRows = HuaAnFundOfficialProvider.parseNavTable(await navResponse.text());
      const detail = HuaAnFundOfficialProvider.parseFundDetailPage(detailHtml, input.fund_code);
      const currentNav = detail.currentNav ?? navRows.at(-1)?.nav;
      const currentNavDate = detail.currentNavDate ?? navRows.at(-1)?.date;
      const navHistory = navRows.map((row) => row.nav);
      const navHistoryDates = navRows.map((row) => row.date);
      const documents = detail.notices.map((notice, index) => this.documentFor(notice, index));
      const freshness = this.freshnessFor(currentNavDate);
      const warnings = [
        "华安基金官网是基金公司官方来源；当前 provider 解析官网详情页、净值表、持仓名称和公告链接，报告 PDF 正文仍需后续接入证监会/公司公告正文解析。"
      ];
      if (!navRows.length) warnings.push("华安基金官网净值表未返回可用历史净值行。");
      if (freshness === "stale") warnings.push("华安基金官网最新净值日期偏旧，强结论应降级。");
      if (!documents.some((document) => document.document_kind === "periodic_report")) {
        warnings.push("华安基金官网详情页未识别到完整定期报告正文，official_fund_reports 仍需证监会或官方 PDF 交叉验证。");
      }

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: currentNav !== undefined && navRows.length ? "partial" : "insufficient",
        success: currentNav !== undefined || navRows.length > 0 || Boolean(detail.fundName),
        data: {
          fund_code: input.fund_code,
          fund_name: detail.fundName,
          fund_type: detail.fundType,
          current_nav: currentNav,
          daily_return: detail.dailyReturn ?? navRows.at(-1)?.dailyReturn,
          nav_history: navHistory,
          nav_history_dates: navHistoryDates,
          portfolio_holdings: detail.holdings,
          holdings_as_of: detail.holdingsAsOf,
          holdings_source: "华安基金官网投资组合",
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents.slice(0, 5).map((document) => `华安基金官网公告：${document.title}（${document.published_at ?? "日期未知"}）`)
        },
        raw_reference: detailUrl,
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
        ["华安基金官网官方数据抓取失败，应保留官方 current_nav/nav_history/fund_reports 缺口并尝试其他基金公司、证监会或授权 API。"],
        detailUrl
      );
    }
  }

  static parseFundDetailPage(
    html: string,
    fundCode: string
  ): {
    fundName?: string;
    fundType?: string;
    currentNav?: number;
    currentNavDate?: string;
    dailyReturn?: number;
    holdings: string[];
    holdingsAsOf?: string;
    notices: HuaAnNotice[];
  } {
    if (!html.includes(fundCode)) return { holdings: [], notices: [] };
    const heading = this.firstMatch(html, /<h1>\s*([^<]+?)\s*<strong>\s*\d{6}\s*<\/strong>/u);
    const metaName = this.firstMatch(html, /<meta name="keywords" content="([^"]+)"/u)?.split(",")[0];
    const fundType = this.firstMatch(html, /<b class="typeico\d*">([^<]+)<\/b>/u) ?? this.tableValueFor(html, "基金类型");
    const navBlock = /最新净值（(\d{2}-\d{2})）<b>([\d.]+)<\/b>/u.exec(html);
    const fundDate = this.firstMatch(html, /fundDate\s*=\s*"(\d{4}-\d{2}-\d{2})"/u);
    const currentNavDate = fundDate ?? this.fullDateFromShort(navBlock?.[1]);
    const currentNav = this.numberOrUndefined(navBlock?.[2]) ?? this.numberOrUndefined(this.listValueFor(html, "单位净值"));
    const dailyReturn = this.numberOrUndefined(this.firstMatch(html, /<span class="f_333">涨跌<\/span><br><span[^>]*>([-+]?\d+(?:\.\d+)?)%<\/span>/u));
    const holdingsAsOf = this.firstMatch(html, /以下数据截止(\d{4}-\d{2}-\d{2})[\s\S]{0,80}前十名股票投资明细/u);

    return {
      fundName: heading ?? metaName ?? this.tableValueFor(html, "基金简称"),
      fundType,
      currentNav,
      currentNavDate,
      dailyReturn,
      holdings: this.parseTopStockHoldings(html),
      holdingsAsOf,
      notices: this.parseNoticeLinks(html)
    };
  }

  static parseNavTable(html: string): HuaAnNavRow[] {
    const rows: HuaAnNavRow[] = [];
    const rowPattern = /<tr>\s*<td class="th1">(\d{4}-\d{2}-\d{2})<\/td>\s*<td class="th2">([\d.]+)<\/td>\s*<td class="th2">([\d.]+)<\/td>\s*<td class="th3"[\s\S]*?<span[^>]*>([-+]?\d+(?:\.\d+)?)%<\/span>[\s\S]*?<\/tr>/gu;
    for (const match of html.matchAll(rowPattern)) {
      const date = match[1];
      const nav = this.numberOrUndefined(match[2]);
      const accumulatedNav = this.numberOrUndefined(match[3]);
      const dailyReturn = this.numberOrUndefined(match[4]);
      if (!date || nav === undefined) continue;
      rows.push({ date, nav, accumulatedNav, dailyReturn });
    }
    return rows.sort((left, right) => left.date.localeCompare(right.date));
  }

  static parseNoticeLinks(html: string): HuaAnNotice[] {
    const notices = new Map<string, HuaAnNotice>();
    const pattern = /<li><span[^>]*>(\d{4}-\d{2}-\d{2})<\/span><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/li>/gu;
    for (const match of html.matchAll(pattern)) {
      const publishedAt = match[1] ?? null;
      const href = match[2];
      const title = this.stripHtml(match[3] ?? "");
      if (!href || !title) continue;
      const detailUrl = href.startsWith("http") ? href : `${HuaAnFundOfficialProvider.baseUrl}${href}`;
      notices.set(`${publishedAt}:${title}`, { title, publishedAt, detailUrl });
    }
    return [...notices.values()];
  }

  private static parseTopStockHoldings(html: string): string[] {
    const headerIndex = html.indexOf("前十名股票投资明细");
    if (headerIndex < 0) return [];
    const section = html.slice(headerIndex, headerIndex + 12_000);
    const holdings: string[] = [];
    const rowPattern = /<tr>\s*<td>(\d{6})<\/td>\s*<td>([^<]+)<\/td>/gu;
    for (const match of section.matchAll(rowPattern)) {
      const code = match[1];
      const name = this.stripHtml(match[2] ?? "");
      if (code && name) holdings.push(`${name}(${code})`);
    }
    return [...new Set(holdings)];
  }

  private documentFor(notice: HuaAnNotice, index: number): FundReportDocument {
    return {
      title: notice.title,
      announcement_id: `huaan-${notice.publishedAt ?? "unknown"}-${index}`,
      published_at: notice.publishedAt,
      category: null,
      document_kind: this.documentKindFor(notice.title),
      detail_url: notice.detailUrl,
      pdf_url: null,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "华安基金官网",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private documentKindFor(title: string): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告/u.test(title)) return "periodic_report";
    if (/招募说明书|基金合同|托管协议|产品资料概要|销售文件/u.test(title)) return "sales_document";
    if (/分红|申购|赎回|开放|暂停|转换|公告/u.test(title)) return "business_notice";
    return "other";
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""}`;
  }

  private fundDetailUrl(fundCode: string): string {
    return `${HuaAnFundOfficialProvider.baseUrl}/funds/${fundCode}/index.shtml`;
  }

  private navTableUrl(fundCode: string): string {
    return `${HuaAnFundOfficialProvider.baseUrl}/funddetail/selectFundayByCode.do?fd.fundcode=${encodeURIComponent(fundCode)}`;
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
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

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 10) return "fresh";
    if (ageDays <= 30) return "acceptable";
    return "stale";
  }

  private static tableValueFor(html: string, label: string): string | undefined {
    return this.firstMatch(html, new RegExp(`<td class="hd">${label}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "u"));
  }

  private static listValueFor(html: string, label: string): string | undefined {
    return this.firstMatch(html, new RegExp(`<span class="f_333">${label}<\\/span><br><span[^>]*>([^<]+)<\\/span>`, "u"));
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static stripHtml(value: string): string {
    return value.replace(/<[^>]+>/gu, "").replace(/&nbsp;/gu, " ").replace(/\s+/gu, " ").trim();
  }

  private static numberOrUndefined(value?: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value.replace(/,/gu, "").replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static fullDateFromShort(shortDate?: string): string | undefined {
    if (!shortDate || !/^\d{2}-\d{2}$/u.test(shortDate)) return undefined;
    return `${new Date().getUTCFullYear()}-${shortDate}`;
  }

  private static isUnavailablePage(html: string): boolean {
    return /此次请求暂不能处理|404notfound|欢迎访问本站点，你的此次请求暂不能处理/u.test(html);
  }
}
