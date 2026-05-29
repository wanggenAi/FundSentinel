import { TextDecoder } from "node:util";
import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface ChinaAmcNavRow {
  date: string;
  nav: number;
  accumulatedNav?: number;
}

interface ChinaAmcNotice {
  title: string;
  publishedAt: string | null;
  detailUrl: string;
}

interface ChinaAmcNoticeDetail {
  title?: string;
  publishedAt?: string;
  pdfUrl: string | null;
}

export class ChinaAmcOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.chinaamc.com";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly maxDetailFetches = Number(process.env.FUNDSENTINEL_CHINAAMC_DETAIL_FETCH_COUNT ?? 5),
    private readonly verifyPdfCount = Number(process.env.FUNDSENTINEL_CHINAAMC_VERIFY_PDF_COUNT ?? 3)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "chinaamc-official",
      source_name: "华夏基金官网官方净值与披露 Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 7,
      access_method: "official fund company website: https://www.chinaamc.com/fund/{fund_code}/index.shtml plus /product fund NAV and announcement endpoints",
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
        "Parses ChinaAMC official fund pages, official NAV iframe endpoint, asset-composition page, announcement list, and PDF metadata. PDF body text remains separate coverage."
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
    const portfolioUrl = this.portfolioUrl(input.fund_code);
    const noticeListUrl = this.noticeListUrl(input.fund_code);
    const warnings = [
      "华夏基金官网是基金公司官方来源；当前 provider 解析官网详情页、历史净值接口、资产组合页、公告详情和 PDF 元数据，PDF 正文仍需后续解析。"
    ];

    try {
      const detailResponse = await this.fetchWithTimeout(detailUrl, { headers: this.headers() }, this.timeoutMs);
      if (!detailResponse.ok) return this.failure(info, `detail HTTP ${detailResponse.status}`, [`华夏基金官网详情页返回 HTTP ${detailResponse.status}。`], detailUrl);

      const detailHtml = await this.decodeResponse(detailResponse, "gb18030");
      const detail = ChinaAmcOfficialProvider.parseFundDetailPage(detailHtml, input.fund_code);
      if (ChinaAmcOfficialProvider.isUnavailablePage(detailHtml) || (!detail.fundName && detail.currentNav === undefined)) {
        return this.failure(info, "Fund not found on ChinaAMC official website", ["华夏基金官网未返回可验证的基金详情页。"], detailUrl);
      }

      const [navHtml, portfolioHtml, noticeListHtml] = await Promise.all([
        this.fetchOptionalText(navUrl, "utf-8", warnings, "华夏基金官网历史净值接口"),
        this.fetchOptionalText(portfolioUrl, "gb18030", warnings, "华夏基金官网资产组合页"),
        this.fetchOptionalText(noticeListUrl, "utf-8", warnings, "华夏基金官网产品公告接口")
      ]);
      const navRows = navHtml ? ChinaAmcOfficialProvider.parseNavRows(navHtml) : [];
      const portfolio = portfolioHtml ? ChinaAmcOfficialProvider.parsePortfolioPage(portfolioHtml) : { holdings: [] as string[], holdingsAsOf: undefined };
      const notices = noticeListHtml ? ChinaAmcOfficialProvider.parseNoticeList(noticeListHtml, noticeListUrl) : [];
      const noticeDetails = await this.fetchNoticeDetails(
        notices.filter((notice) => this.isDocumentLike(notice.title)).slice(0, Math.max(0, this.maxDetailFetches)),
        warnings
      );
      const documents = notices.map((notice, index) => this.documentFor(notice, index, noticeDetails.get(notice.detailUrl)));
      await this.verifyPdfDocuments(documents, warnings);

      const currentNav = detail.currentNav ?? navRows.at(-1)?.nav;
      const currentNavDate = detail.currentNavDate ?? navRows.at(-1)?.date;
      const freshness = this.freshnessFor(currentNavDate);
      if (!navRows.length) warnings.push("华夏基金官网历史净值接口未返回可用净值行。");
      if (!portfolio.holdings.length) warnings.push("华夏基金官网资产组合页未识别到前十持仓。");
      if (!documents.some((document) => document.document_kind === "periodic_report")) {
        warnings.push("华夏基金官网公告列表未识别到完整定期报告，official_fund_reports 仍需证监会或官方 PDF 交叉验证。");
      } else if (!documents.some((document) => document.document_kind === "periodic_report" && document.pdf_verified)) {
        warnings.push("华夏基金官网识别到定期报告公告，但尚未通过 PDF 元数据校验，official_fund_reports 不应视为完整覆盖。");
      }
      if (freshness === "stale") warnings.push("华夏基金官网最新净值日期偏旧，强结论应降级。");

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
          daily_return: detail.dailyReturn,
          nav_history: navRows.map((row) => row.nav),
          nav_history_dates: navRows.map((row) => row.date),
          portfolio_holdings: portfolio.holdings,
          holdings_as_of: portfolio.holdingsAsOf,
          holdings_source: "华夏基金官网资产组合",
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents.slice(0, 5).map((document) => `华夏基金官网公告：${document.title}（${document.published_at ?? "日期未知"}）`)
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
        ["华夏基金官网官方数据抓取失败，应保留官方 current_nav/nav_history/fund_reports 缺口并尝试其他基金公司、证监会或授权 API。"],
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
  } {
    if (!html.includes(fundCode)) return {};
    const currentNavBlock = /<div class="t1">\s*([\d.]+)\s*<\/div>\s*<div class="t2">\s*净值\s*（(\d{4}-\d{2}-\d{2})）/u.exec(html);
    return {
      fundName:
        this.firstMatch(html, /<a\s+title="([^"]+)"\s+id="text"[^>]*>/u) ??
        this.firstMatch(html, /<div id="nametext"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/u),
      fundType: this.firstMatch(html, /<div class="txt">\s*([^<]*型)\s*<\/div>/u),
      currentNav: this.numberOrUndefined(currentNavBlock?.[1]),
      currentNavDate: currentNavBlock?.[2],
      dailyReturn: this.numberOrUndefined(
        this.firstMatch(
          html,
          /<div class="item">\s*<div class="t1">\s*(?:<span[^>]*>)?\s*([-+]?\d+(?:\.\d+)?)%\s*(?:<\/span>)?\s*<\/div>\s*<div class="t2">\s*日涨跌幅/u
        )
      )
    };
  }

  static parseNavRows(html: string): ChinaAmcNavRow[] {
    const rows = new Map<string, ChinaAmcNavRow>();
    const rowPattern =
      /<tr>\s*<td>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>[\s\S]*?<td>\s*(?:<span>)?\s*([\d.]+)\s*(?:<\/span>)?\s*<\/td>[\s\S]*?<td>\s*([\d.]+)\s*<\/td>/gu;
    for (const match of html.matchAll(rowPattern)) {
      const date = match[1];
      const nav = this.numberOrUndefined(match[2]);
      if (!date || nav === undefined) continue;
      rows.set(date, {
        date,
        nav,
        accumulatedNav: this.numberOrUndefined(match[3])
      });
    }
    return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  static parsePortfolioPage(html: string): { holdings: string[]; holdingsAsOf?: string } {
    const start = html.indexOf("前十股票");
    const section = start >= 0 ? html.slice(start, start + 18_000) : html;
    const holdings: string[] = [];
    const rowPattern =
      /<div class="li middle-box">\s*<div class="middle-cont">\s*<div class="div clearfix">\s*<div class="item">(\d{6})<\/div>\s*<div class="item">([^<]+)<\/div>\s*<div class="item">([\d.]+|-)<\/div>/gu;
    for (const match of section.matchAll(rowPattern)) {
      const code = match[1];
      const name = this.stripHtml(match[2] ?? "");
      if (code && name) holdings.push(`${name}(${code})`);
    }
    return {
      holdings: [...new Set(holdings)],
      holdingsAsOf: this.firstMatch(section, /截止日期\s*(\d{4}-\d{2}-\d{2})/u)
    };
  }

  static parseNoticeList(html: string, pageUrl = ChinaAmcOfficialProvider.baseUrl): ChinaAmcNotice[] {
    const notices = new Map<string, ChinaAmcNotice>();
    const pattern =
      /<div class="item"><a target="_blank" href="([^"]+)">\s*([\s\S]*?)<\/a><\/div>\s*<div class="item">(\d{4}-\d{2}-\d{2})<\/div>/gu;
    for (const match of html.matchAll(pattern)) {
      const detailUrl = this.resolveUrl(match[1] ?? "", pageUrl);
      const title = this.stripHtml(match[2] ?? "");
      const publishedAt = match[3] ?? null;
      if (!detailUrl || !title) continue;
      notices.set(`${publishedAt}:${title}`, { title, publishedAt, detailUrl });
    }
    return [...notices.values()];
  }

  static parseNoticeDetailPage(html: string, detailUrl: string): ChinaAmcNoticeDetail {
    return {
      title:
        this.firstMatch(html, /<div class="t"[^>]*>([\s\S]*?)<\/div>/u) ??
        this.firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/u) ??
        this.firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/u),
      publishedAt:
        this.firstMatch(html, /时间[：:\s]*(\d{4}-\d{2}-\d{2})/u) ??
        this.firstMatch(html, /(?:发布日期|发布时间|日期)[：:\s]*(\d{4}-\d{2}-\d{2})/u) ??
        this.firstMatch(html, /(\d{4}-\d{2}-\d{2})/u),
      pdfUrl: this.firstPdfUrl(html, detailUrl)
    };
  }

  private async fetchOptionalText(url: string, fallbackEncoding: string, warnings: string[], label: string): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
      if (!response.ok) {
        warnings.push(`${label}返回 HTTP ${response.status}。`);
        return null;
      }
      return await this.decodeResponse(response, fallbackEncoding);
    } catch (error) {
      warnings.push(`${label}抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return null;
    }
  }

  private async fetchNoticeDetails(notices: ChinaAmcNotice[], warnings: string[]): Promise<Map<string, ChinaAmcNoticeDetail>> {
    const detailMap = new Map<string, ChinaAmcNoticeDetail>();
    await Promise.all(
      notices.map(async (notice) => {
        try {
          const response = await this.fetchWithTimeout(notice.detailUrl, { headers: this.headers() }, Math.min(this.timeoutMs, 5000));
          if (!response.ok) {
            warnings.push(`华夏基金官网公告详情返回 HTTP ${response.status}：${notice.title}。`);
            return;
          }
          detailMap.set(notice.detailUrl, ChinaAmcOfficialProvider.parseNoticeDetailPage(await this.decodeResponse(response, "utf-8"), notice.detailUrl));
        } catch (error) {
          warnings.push(`华夏基金官网公告详情抓取失败：${notice.title} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
    return detailMap;
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
          if (!document.pdf_verified) warnings.push(`华夏基金官网报告 PDF 未通过 HEAD 校验：${document.announcement_id}。`);
        } catch (error) {
          warnings.push(`华夏基金官网报告 PDF 校验失败：${document.announcement_id} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
  }

  private documentFor(notice: ChinaAmcNotice, index: number, detail?: ChinaAmcNoticeDetail): FundReportDocument {
    const title = detail?.title ?? notice.title;
    return {
      title,
      announcement_id: `chinaamc-${notice.publishedAt ?? "unknown"}-${ChinaAmcOfficialProvider.announcementIdFrom(notice.detailUrl) ?? index}`,
      published_at: detail?.publishedAt ?? notice.publishedAt,
      category: null,
      document_kind: this.documentKindFor(title),
      detail_url: notice.detailUrl,
      pdf_url: detail?.pdfUrl ?? null,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "华夏基金官网",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private documentKindFor(title: string): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告/u.test(title)) return "periodic_report";
    if (/招募说明书|基金合同|托管协议|产品资料概要|销售文件/u.test(title)) return "sales_document";
    if (/分红|申购|赎回|开放|暂停|转换|基金经理|公告/u.test(title)) return "business_notice";
    return "other";
  }

  private isDocumentLike(title: string): boolean {
    return /季度报告|年度报告|中期报告|招募说明书|基金合同|托管协议|产品资料概要/u.test(title);
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""} pdf=${document.pdf_url ?? ""} pdf_verified=${document.pdf_verified}`;
  }

  private fundDetailUrl(fundCode: string): string {
    return `${ChinaAmcOfficialProvider.baseUrl}/fund/${encodeURIComponent(fundCode)}/index.shtml`;
  }

  private navHistoryUrl(fundCode: string): string {
    return `${ChinaAmcOfficialProvider.baseUrl}/product/fundLishijingzhi.do?fundcode=${encodeURIComponent(fundCode)}`;
  }

  private portfolioUrl(fundCode: string): string {
    return `${ChinaAmcOfficialProvider.baseUrl}/fund/${encodeURIComponent(fundCode)}/zichanzuhe.shtml?source=click`;
  }

  private noticeListUrl(fundCode: string): string {
    return `${ChinaAmcOfficialProvider.baseUrl}/product/publishGgList.do?fundcode=${encodeURIComponent(fundCode)}`;
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

  private async decodeResponse(response: Response, fallbackEncoding: string): Promise<string> {
    const bytes = Buffer.from(await response.arrayBuffer());
    const headerEncoding = ChinaAmcOfficialProvider.charsetFrom(response.headers.get("content-type"));
    const headText = bytes.toString("latin1", 0, Math.min(bytes.length, 4096));
    const metaEncoding = ChinaAmcOfficialProvider.charsetFrom(headText);
    const encoding = ChinaAmcOfficialProvider.normalizeEncoding(headerEncoding ?? metaEncoding ?? fallbackEncoding);
    return new TextDecoder(encoding).decode(bytes);
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
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

  private static firstPdfUrl(html: string, detailUrl: string): string | null {
    const attributeMatch = /(?:href|src)=["']([^"']+\.pdf(?:[?#][^"']*)?)["']/iu.exec(html);
    const rawMatch = /https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/iu.exec(html);
    const candidate = attributeMatch?.[1] ?? rawMatch?.[0];
    return candidate ? this.resolveUrl(candidate, detailUrl) : null;
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<[^>]+>/gu, "")
      .replace(/&#32;/gu, " ")
      .replace(/&emsp;/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim();
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

  private static announcementIdFrom(url: string): string | null {
    const match = /\/c\/\d{4}-\d{2}-\d{2}\/([^/?#]+)\.shtml/iu.exec(url);
    return match?.[1]?.slice(0, 80) ?? null;
  }

  private static charsetFrom(value: string | null): string | null {
    return /charset=["']?\s*([a-zA-Z0-9_-]+)/iu.exec(value ?? "")?.[1] ?? null;
  }

  private static normalizeEncoding(encoding: string): string {
    const normalized = encoding.toLowerCase();
    if (["gbk", "gb2312", "gb18030"].includes(normalized)) return "gb18030";
    return normalized;
  }

  private static isUnavailablePage(html: string): boolean {
    return /404notfound|Not Found|此次请求暂不能处理|不存在|无法访问/u.test(html);
  }
}
