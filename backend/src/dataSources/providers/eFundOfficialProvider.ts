import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface EFundNavRow {
  date: string;
  nav: number;
  accumulatedNav?: number;
  dailyReturn?: number;
}

interface EFundNotice {
  title: string;
  publishedAt: string | null;
  pdfUrl: string;
  announcementId: string;
}

export class EFundOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.efunds.com.cn";
  private static readonly cdnBaseUrl = "https://cdn.efunds.com.cn";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly verifyPdfCount = Number(process.env.FUNDSENTINEL_EFUND_VERIFY_PDF_COUNT ?? 3)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "efund-official",
      source_name: "易方达基金官网官方净值 Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 7,
      access_method: "official fund company website: https://www.efunds.com.cn/fund/{fund_code}.shtml and CDN market JS",
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
      notes:
        "Parses E Fund official fund pages, official CDN NAV history JS, disclosed holdings, and announcement PDF metadata. It does not parse PDF body text or make fund advice."
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
    const navUrl = this.navHistoryUrl(input.fund_code);
    try {
      const [detailResponse, navResponse] = await Promise.all([
        this.fetchWithTimeout(detailUrl, { headers: this.headers() }, this.timeoutMs),
        this.fetchWithTimeout(navUrl, { headers: { ...this.headers(), referer: detailUrl } }, this.timeoutMs)
      ]);

      if (!detailResponse.ok) return this.failure(info, `detail HTTP ${detailResponse.status}`, [`易方达基金官网详情页返回 HTTP ${detailResponse.status}。`], detailUrl);
      if (!navResponse.ok) return this.failure(info, `nav history HTTP ${navResponse.status}`, [`易方达基金官网历史净值 JS 返回 HTTP ${navResponse.status}。`], navUrl);

      const detailHtml = await detailResponse.text();
      const detail = EFundOfficialProvider.parseFundDetailPage(detailHtml, input.fund_code);
      if (EFundOfficialProvider.isUnavailablePage(detailHtml) || !detail.fundName) {
        return this.failure(info, "Fund not found on E Fund official website", ["易方达基金官网未返回可验证的基金详情页。"], detailUrl);
      }

      const navRows = EFundOfficialProvider.parseMarketNavJs(await navResponse.text(), input.fund_code);
      const currentNav = detail.currentNav ?? navRows.at(-1)?.nav;
      const currentNavDate = detail.currentNavDate ?? navRows.at(-1)?.date;
      const warnings = [
        "易方达基金官网是基金公司官方来源；当前 provider 解析官网详情页、CDN 净值历史、持仓名称、公告 PDF 元数据，PDF 正文仍需后续接入证监会/公司公告全文解析。"
      ];
      if (!navRows.length) warnings.push("易方达基金官网历史净值 JS 未返回可用净值行。");

      const documents = detail.notices.map((notice) => this.documentFor(notice));
      await this.verifyPdfDocuments(documents, warnings);
      if (!documents.some((document) => document.document_kind === "periodic_report")) {
        warnings.push("易方达基金官网公告列表未识别到完整定期报告正文，official_fund_reports 仍需证监会或官方 PDF 交叉验证。");
      } else if (!documents.some((document) => document.document_kind === "periodic_report" && document.pdf_verified)) {
        warnings.push("易方达基金官网识别到定期报告 PDF 链接，但尚未通过 PDF 元数据校验，official_fund_reports 不应视为完整覆盖。");
      }

      const freshness = this.freshnessFor(currentNavDate);
      if (freshness === "stale") warnings.push("易方达基金官网最新净值日期偏旧，强结论应降级。");

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
          nav_history: navRows.map((row) => row.nav),
          nav_history_dates: navRows.map((row) => row.date),
          portfolio_holdings: detail.holdings,
          holdings_as_of: detail.holdingsAsOf,
          holdings_source: "易方达基金官网投资组合",
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents.slice(0, 5).map((document) => `易方达基金官网公告：${document.title}（${document.published_at ?? "日期未知"}）`)
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
        ["易方达基金官网官方数据抓取失败，应保留官方 current_nav/nav_history/fund_reports 缺口并尝试其他基金公司、证监会或授权 API。"],
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
    notices: EFundNotice[];
  } {
    if (!html.includes(fundCode)) return { holdings: [], notices: [] };
    return {
      fundName: this.firstMatch(html, /var fundName\s*=\s*"([^"]+)"/u) ?? this.tableValueFor(html, "基金名称"),
      fundType: this.tableValueFor(html, "基金类型"),
      currentNav: this.numberOrUndefined(this.firstMatch(html, /<div id="net-today"[^>]*>([^<]+)<\/div>/u)),
      currentNavDate: this.firstMatch(html, /基金净值日期：<span class="nav-update">(\d{4}-\d{2}-\d{2})<\/span>/u),
      dailyReturn: this.numberOrUndefined(this.firstMatch(html, /<div id="net-scale"[^>]*>([-+]?\d+(?:\.\d+)?)%<\/div>/u)),
      holdings: this.parseHoldings(html),
      holdingsAsOf: this.firstMatch(html, /var assets_searchDate='(\d{4}-\d{2}-\d{2})'/u),
      notices: this.parseNoticeList(html)
    };
  }

  static parseMarketNavJs(text: string, fundCode: string): EFundNavRow[] {
    const escapedCode = fundCode.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`mk_${escapedCode}_(?:all|1y)\\s*=\\s*"([^"]*)"`, "u").exec(text);
    const payload = match?.[1];
    if (!payload) return [];

    const rows = new Map<string, EFundNavRow>();
    for (const part of payload.split(";").slice(1)) {
      const fields = part.split("_");
      const date = this.normalizeCompactDate(fields[0]);
      const nav = this.numberOrUndefined(fields[2]);
      if (!date || nav === undefined) continue;
      rows.set(date, {
        date,
        nav,
        accumulatedNav: this.numberOrUndefined(fields[3]),
        dailyReturn: this.numberOrUndefined(fields[4])
      });
    }
    return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  static parseNoticeList(html: string): EFundNotice[] {
    const notices = new Map<string, EFundNotice>();
    const rowPattern = /<tr>[\s\S]*?<td><a href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a><\/td>\s*<td>(\d{4}-\d{2}-\d{2})<span[^>]*>([^<]+)<\/span><\/td>[\s\S]*?<\/tr>/gu;
    for (const match of html.matchAll(rowPattern)) {
      const pdfUrl = this.resolveUrl(match[1] ?? "", EFundOfficialProvider.baseUrl);
      const title = this.stripHtml(match[2] ?? "");
      const publishedAt = match[3] ?? null;
      const announcementId = this.stripHtml(match[4] ?? "") || this.announcementIdFrom(pdfUrl);
      if (!pdfUrl || !title) continue;
      notices.set(`${announcementId}:${title}`, { title, publishedAt, pdfUrl, announcementId });
    }
    return [...notices.values()];
  }

  private static parseHoldings(html: string): string[] {
    const listMatch = /var investList\s*=\s*(\[[\s\S]*?\])\s*\/\/\s*investList\.push/u.exec(html);
    const jsonText = listMatch?.[1];
    if (!jsonText) return this.parseHoldingTable(html);
    try {
      const parsed = JSON.parse(jsonText) as Array<{ investInfoData?: Array<{ namechinese?: string; name?: string; symbol?: string }> }>;
      return [
        ...new Set(
          parsed.flatMap((group) =>
            (group.investInfoData ?? []).flatMap((item) => {
              const name = this.stripHtml(item.namechinese ?? item.name ?? "");
              const symbol = this.stripHtml(item.symbol ?? "").replace(/\s+/gu, " ");
              return name ? [`${name}${symbol ? `(${symbol})` : ""}`] : [];
            })
          )
        )
      ];
    } catch {
      return this.parseHoldingTable(html);
    }
  }

  private static parseHoldingTable(html: string): string[] {
    const holdings: string[] = [];
    const rowPattern = /<tr>\s*<td>\d+<\/td>[\s\S]*?<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>[\s\S]*?<\/tr>/gu;
    for (const match of html.matchAll(rowPattern)) {
      const name = this.stripHtml(match[1] ?? "");
      const symbol = this.stripHtml(match[2] ?? "").replace(/\s+/gu, " ");
      if (name) holdings.push(`${name}${symbol ? `(${symbol})` : ""}`);
    }
    return [...new Set(holdings)];
  }

  private async verifyPdfDocuments(documents: FundReportDocument[], warnings: string[]): Promise<void> {
    const candidates = documents.filter((document) => document.pdf_url).slice(0, Math.max(0, this.verifyPdfCount));
    await Promise.all(
      candidates.map(async (document) => {
        try {
          const response = await this.fetchWithTimeout(document.pdf_url!, { method: "HEAD", headers: this.pdfHeaders() }, Math.min(this.timeoutMs, 5000));
          const contentType = response.headers.get("content-type");
          const contentLength = response.headers.get("content-length");
          const parsedLength = contentLength ? Number(contentLength) : null;
          document.pdf_verified = response.ok && Boolean(contentType?.toLowerCase().includes("pdf"));
          document.pdf_content_type = contentType;
          document.pdf_content_length = parsedLength !== null && Number.isFinite(parsedLength) ? parsedLength : document.pdf_content_length;
          if (!document.pdf_verified) warnings.push(`易方达基金官网报告 PDF 未通过 HEAD 校验：${document.announcement_id}。`);
        } catch (error) {
          warnings.push(`易方达基金官网报告 PDF 校验失败：${document.announcement_id} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
  }

  private documentFor(notice: EFundNotice): FundReportDocument {
    return {
      title: notice.title,
      announcement_id: `efund-${notice.publishedAt ?? "unknown"}-${notice.announcementId}`,
      published_at: notice.publishedAt,
      category: null,
      document_kind: this.documentKindFor(notice.title),
      detail_url: notice.pdfUrl,
      pdf_url: notice.pdfUrl,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "易方达基金官网",
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
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""} pdf=${document.pdf_url ?? ""} pdf_verified=${document.pdf_verified}`;
  }

  private fundDetailUrl(fundCode: string): string {
    return `${EFundOfficialProvider.baseUrl}/fund/${encodeURIComponent(fundCode)}.shtml`;
  }

  private navHistoryUrl(fundCode: string): string {
    return `${EFundOfficialProvider.cdnBaseUrl}/market/2.0/his/${encodeURIComponent(fundCode)}_all.js`;
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
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/javascript,*/*;q=0.8"
    };
  }

  private pdfHeaders(): HeadersInit {
    return {
      ...this.headers(),
      accept: "application/pdf,*/*;q=0.8"
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
    return this.firstMatch(html, new RegExp(`<td class="baseinfo-table-left">${label}:<\\/td>\\s*<td class="baseinfo-table-right[^"]*">([\\s\\S]*?)<\\/td>`, "u"));
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<[^>]+>/gu, "")
      .replace(/&#32;/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static normalizeCompactDate(value?: string): string | null {
    if (!value) return null;
    const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  private static numberOrUndefined(value?: string): number | undefined {
    if (!value || value === "--") return undefined;
    const parsed = Number(value.replace(/,/gu, "").replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static resolveUrl(href: string, pageUrl: string): string | null {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  }

  private static announcementIdFrom(url: string | null): string {
    if (!url) return "unknown";
    return decodeURIComponent(url).split("/").pop()?.replace(/\.pdf(?:[?#].*)?$/iu, "").slice(0, 80) || "unknown";
  }

  private static isUnavailablePage(html: string): boolean {
    return /404notfound|此次请求暂不能处理|不存在|无法访问/u.test(html);
  }
}
