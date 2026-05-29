import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface FullgoalNavRow {
  date: string;
  nav: number;
  accumulatedNav?: number;
  dailyReturn?: number;
}

interface FullgoalNotice {
  id: string | null;
  title: string;
  publishedAt: string | null;
  detailUrl: string;
}

interface FullgoalNoticeDetail {
  title?: string;
  publishedAt?: string;
  pdfUrl: string | null;
}

interface FullgoalFundDetail {
  fundName?: string;
  fundFullName?: string;
  fundType?: string;
  currentNav?: number;
  accumulatedNav?: number;
  currentNavDate?: string;
  dailyReturn?: number;
  navRows: FullgoalNavRow[];
  notices: FullgoalNotice[];
}

export class FullgoalFundOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.fullgoal.com.cn";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly maxDetailFetches = Number(process.env.FUNDSENTINEL_FULLGOAL_DETAIL_FETCH_COUNT ?? 4),
    private readonly verifyPdfCount = Number(process.env.FUNDSENTINEL_FULLGOAL_VERIFY_PDF_COUNT ?? 3)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "fullgoal-fund-official",
      source_name: "富国基金官网官方净值与披露 Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 7,
      access_method: "official fund company website: https://www.fullgoal.com.cn/fundDetail/{fund_code}/index.html?isdividend=1 and /noticedetails/{id}/index.html",
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
        "Parses Fullgoal official SSR fund pages, NAV rows, disclosure detail pages, and official PDF metadata. It does not parse PDF body text beyond metadata."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history", "fund_reports"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/u.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const detailUrl = this.fundDetailUrl(input.fund_code);
    const warnings = [
      "富国基金官网是基金公司官方来源；当前 provider 解析官网 SSR 详情页、净值表、公告详情和 PDF 元数据，PDF 正文仍需后续解析。",
      "富国基金官网页面可能包含非披露入口；Argus 仅读取公开详情、净值和公告 PDF 元数据。"
    ];

    try {
      const detailResponse = await this.fetchWithTimeout(detailUrl, { headers: this.headers() }, this.timeoutMs);
      if (!detailResponse.ok) return this.failure(info, `detail HTTP ${detailResponse.status}`, [`富国基金官网详情页返回 HTTP ${detailResponse.status}。`], detailUrl);

      const detailHtml = await detailResponse.text();
      const detail = FullgoalFundOfficialProvider.parseFundDetailPage(detailHtml, input.fund_code);
      if (FullgoalFundOfficialProvider.isUnavailablePage(detailHtml) || (!detail.fundName && detail.currentNav === undefined && !detail.navRows.length)) {
        return this.failure(info, "Fund not found on Fullgoal official website", ["富国基金官网未返回可验证的基金详情、净值或公告数据。"], detailUrl);
      }

      const noticeDetails = await this.fetchNoticeDetails(
        detail.notices.filter((notice) => this.isDocumentLike(notice.title)).slice(0, Math.max(0, this.maxDetailFetches)),
        warnings
      );
      const documents = detail.notices.map((notice, index) => this.documentFor(notice, index, noticeDetails.get(notice.detailUrl)));
      await this.verifyPdfDocuments(documents, warnings);

      const currentNav = detail.currentNav ?? detail.navRows.at(-1)?.nav;
      const currentNavDate = detail.currentNavDate ?? detail.navRows.at(-1)?.date;
      const freshness = this.freshnessFor(currentNavDate);
      if (!detail.navRows.length) warnings.push("富国基金官网详情页未返回可用历史净值行。");
      if (!documents.some((document) => document.document_kind === "periodic_report")) {
        warnings.push("富国基金官网公告列表未识别到完整定期报告，official_fund_reports 仍需证监会或官方 PDF 交叉验证。");
      } else if (!documents.some((document) => document.document_kind === "periodic_report" && document.pdf_verified)) {
        warnings.push("富国基金官网识别到定期报告公告，但尚未通过 PDF 元数据校验，official_fund_reports 不应视为完整覆盖。");
      }
      if (freshness === "stale") warnings.push("富国基金官网最新净值日期偏旧，强结论应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: currentNav !== undefined && detail.navRows.length ? "partial" : "insufficient",
        success: currentNav !== undefined || detail.navRows.length > 0 || Boolean(detail.fundName),
        data: {
          fund_code: input.fund_code,
          fund_name: detail.fundName ?? detail.fundFullName,
          fund_type: detail.fundType,
          current_nav: currentNav,
          daily_return: detail.dailyReturn ?? detail.navRows.at(-1)?.dailyReturn,
          nav_history: detail.navRows.map((row) => row.nav),
          nav_history_dates: detail.navRows.map((row) => row.date),
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents.slice(0, 5).map((document) => `富国基金官网公告：${document.title}（${document.published_at ?? "日期未知"}）`)
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
        ["富国基金官网官方数据抓取失败，应保留官方 current_nav/nav_history/fund_reports 缺口并尝试其他基金公司、证监会或授权 API。"],
        detailUrl
      );
    }
  }

  static parseFundDetailPage(html: string, fundCode: string): FullgoalFundDetail {
    if (!html.includes(fundCode)) return { navRows: [], notices: [] };
    const fundFullName = this.tableValueFor(html, "基金名称") ?? this.firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/iu)?.replace(/[-_].*$/u, "").trim();
    const fundName = this.tableValueFor(html, "基金简称") ?? this.firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/iu) ?? fundFullName;
    const fundTags = [...html.matchAll(/<span[^>]+class=["'][^"']*fund_tag_01[^"']*["'][^>]*>([\s\S]*?)<\/span>/giu)]
      .map((match) => this.stripHtml(match[1] ?? ""))
      .filter(Boolean);
    const navBlock = this.currentNavBlock(html);

    return {
      fundName,
      fundFullName,
      fundType: fundTags.find((tag) => !/风险|R\d/u.test(tag)) ?? this.tableValueFor(html, "基金类型"),
      currentNav: navBlock.nav,
      accumulatedNav: this.accumulatedNavFrom(html),
      currentNavDate: navBlock.date,
      dailyReturn: this.dailyReturnFrom(html),
      navRows: this.parseNavRows(html),
      notices: this.parseNoticeLinks(html)
    };
  }

  static parseNavRows(html: string): FullgoalNavRow[] {
    const rows = new Map<string, FullgoalNavRow>();
    for (const rowHtml of html.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? []) {
      const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((match) => this.stripHtml(match[1] ?? ""));
      const date = cells[0];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
      const nav = this.numberOrUndefined(cells[1]);
      const accumulatedNav = this.numberOrUndefined(cells[2]);
      if (nav === undefined || accumulatedNav === undefined) continue;
      rows.set(date, {
        date,
        nav,
        accumulatedNav,
        dailyReturn: this.numberOrUndefined(cells[3])
      });
    }
    return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  static parseNoticeLinks(html: string): FullgoalNotice[] {
    const notices = new Map<string, FullgoalNotice>();
    const pattern = /<a\b[^>]*href=["']([^"']*\/noticedetails\/(\d+)\/index\.html)["'][^>]*>([\s\S]*?)<\/a>/giu;
    for (const match of html.matchAll(pattern)) {
      const href = match[1];
      const id = match[2] ?? null;
      const body = match[3] ?? "";
      const title = this.firstMatch(body, /<p[^>]*>([\s\S]*?)<\/p>/iu) ?? this.stripHtml(body).replace(/\d{4}-\d{2}-\d{2}/u, "").trim();
      const publishedAt =
        this.firstMatch(body, /<span[^>]+class=["'][^"']*(?:time|date)[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu) ?? this.normalizeDate(body) ?? null;
      const detailUrl = href ? this.resolveUrl(href, FullgoalFundOfficialProvider.baseUrl) : null;
      if (!detailUrl || !title) continue;
      notices.set(`${id ?? detailUrl}:${title}`, { id, title, publishedAt, detailUrl });
    }
    return [...notices.values()];
  }

  static parseNoticeDetailPage(html: string, detailUrl: string): FullgoalNoticeDetail {
    return {
      title:
        this.firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/iu) ??
        this.firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/iu) ??
        this.firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/iu)?.replace(/[-_].*$/u, "").trim(),
      publishedAt:
        this.normalizeDate(this.firstMatch(html, /<span[^>]+class=["'][^"']*(?:time|date)[^"']*["'][^>]*>([\s\S]*?)<\/span>/iu)) ??
        this.normalizeDate(html),
      pdfUrl: this.firstPdfUrl(html, detailUrl)
    };
  }

  private async fetchNoticeDetails(notices: FullgoalNotice[], warnings: string[]): Promise<Map<string, FullgoalNoticeDetail>> {
    const detailMap = new Map<string, FullgoalNoticeDetail>();
    await Promise.all(
      notices.map(async (notice) => {
        try {
          const response = await this.fetchWithTimeout(notice.detailUrl, { headers: this.headers() }, Math.min(this.timeoutMs, 5000));
          if (!response.ok) {
            warnings.push(`富国基金官网公告详情返回 HTTP ${response.status}：${notice.title}。`);
            return;
          }
          detailMap.set(notice.detailUrl, FullgoalFundOfficialProvider.parseNoticeDetailPage(await response.text(), notice.detailUrl));
        } catch (error) {
          warnings.push(`富国基金官网公告详情抓取失败：${notice.title} ${error instanceof Error ? error.message : String(error)}。`);
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
          if (!document.pdf_verified) warnings.push(`富国基金官网报告 PDF 未通过 HEAD 校验：${document.announcement_id}。`);
        } catch (error) {
          warnings.push(`富国基金官网报告 PDF 校验失败：${document.announcement_id} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
  }

  private documentFor(notice: FullgoalNotice, index: number, detail?: FullgoalNoticeDetail): FundReportDocument {
    const title = detail?.title ?? notice.title;
    return {
      title,
      announcement_id: `fullgoal-${notice.id ?? index}`,
      published_at: detail?.publishedAt ?? notice.publishedAt,
      category: null,
      document_kind: this.documentKindFor(title),
      detail_url: notice.detailUrl,
      pdf_url: detail?.pdfUrl ?? null,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "富国基金官网",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private documentKindFor(title: string): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告|月度报告/u.test(title)) return "periodic_report";
    if (/招募说明书|基金合同|托管协议|产品资料概要|法律文件|发售公告|风险揭示书/u.test(title)) return "sales_document";
    if (/分红|申购|赎回|开放|暂停|转换|收益分配公告|公告/u.test(title)) return "business_notice";
    return "other";
  }

  private isDocumentLike(title: string): boolean {
    return /季度报告|年度报告|中期报告|月度报告|招募说明书|基金合同|托管协议|产品资料概要|收益分配公告|公告/u.test(title);
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""} pdf=${document.pdf_url ?? ""} pdf_verified=${document.pdf_verified}`;
  }

  private fundDetailUrl(fundCode: string): string {
    return `${FullgoalFundOfficialProvider.baseUrl}/fundDetail/${encodeURIComponent(fundCode)}/index.html?isdividend=1`;
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

  private static currentNavBlock(html: string): { date?: string; nav?: number } {
    const afterLabel = /单位净值\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[)）][\s\S]{0,240}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/iu.exec(html);
    if (afterLabel?.[1] && afterLabel[2]) return { date: afterLabel[1], nav: this.numberOrUndefined(afterLabel[2]) };
    const beforeLabel = /<strong[^>]*>\s*([\d.,]+)\s*<\/strong>[\s\S]{0,240}?单位净值\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[)）]/iu.exec(html);
    return { date: beforeLabel?.[2], nav: this.numberOrUndefined(beforeLabel?.[1]) };
  }

  private static accumulatedNavFrom(html: string): number | undefined {
    const afterLabel = /累计净值[\s\S]{0,180}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/iu.exec(html);
    const beforeLabel = /<strong[^>]*>\s*([\d.,]+)\s*<\/strong>[\s\S]{0,180}?累计净值/iu.exec(html);
    return this.numberOrUndefined(afterLabel?.[1] ?? beforeLabel?.[1]);
  }

  private static dailyReturnFrom(html: string): number | undefined {
    const afterLabel = /日涨跌[\s\S]{0,180}?<strong[^>]*>\s*([-+]?\d+(?:\.\d+)?)%\s*<\/strong>/iu.exec(html);
    const beforeLabel = /<strong[^>]*>\s*([-+]?\d+(?:\.\d+)?)%\s*<\/strong>[\s\S]{0,180}?日涨跌/iu.exec(html);
    return this.numberOrUndefined(afterLabel?.[1] ?? beforeLabel?.[1]);
  }

  private static tableValueFor(html: string, label: string): string | undefined {
    const escapedLabel = this.escapeRegExp(label);
    return (
      this.firstMatch(html, new RegExp(`<th\\b[^>]*>\\s*${escapedLabel}\\s*<\\/th>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, "iu")) ??
      this.firstMatch(html, new RegExp(`<td\\b[^>]*>\\s*${escapedLabel}\\s*<\\/td>\\s*<td\\b[^>]*>([\\s\\S]*?)<\\/td>`, "iu"))
    );
  }

  private static firstPdfUrl(html: string, detailUrl: string): string | null {
    const decoded = html.replace(/\\u002F/giu, "/").replace(/%2F/giu, "/");
    const viewerFileMatch = /[?&]file=([^"'&<>]+\.pdf)/iu.exec(decoded);
    const wbsMatch = /((?:https?:\/\/[^"'<>]+)?\/wbs-file\/[^"'<>]+\.pdf)/iu.exec(decoded);
    const attributeMatch = /(?:href|src)=["']([^"']+\.pdf(?:[?#][^"']*)?)["']/iu.exec(decoded);
    const rawMatch = /https?:\/\/[^\s"'<>]+\.pdf(?:[?#][^\s"'<>]*)?/iu.exec(decoded);
    const candidate = viewerFileMatch?.[1] ?? wbsMatch?.[1] ?? attributeMatch?.[1] ?? rawMatch?.[0];
    return candidate ? this.resolveUrl(candidate, detailUrl) : null;
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, "")
      .replace(/&#32;/gu, " ")
      .replace(/&emsp;/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, "\"")
      .replace(/&#39;/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static numberOrUndefined(value?: string): number | undefined {
    if (!value || value === "--") return undefined;
    const parsed = Number(value.replace(/,/gu, "").replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static normalizeDate(value?: string): string | undefined {
    if (!value) return undefined;
    const iso = /(\d{4})-(\d{2})-(\d{2})/u.exec(value);
    if (iso?.[1] && iso[2] && iso[3]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const chinese = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/u.exec(value);
    if (!chinese?.[1] || !chinese[2] || !chinese[3]) return undefined;
    return `${chinese[1]}-${chinese[2].padStart(2, "0")}-${chinese[3].padStart(2, "0")}`;
  }

  private static resolveUrl(href: string, pageUrl: string): string | null {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  }

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  private static isUnavailablePage(html: string): boolean {
    return /404notfound|Not Found|页面不存在|不存在|无法访问|系统维护/u.test(html);
  }
}
