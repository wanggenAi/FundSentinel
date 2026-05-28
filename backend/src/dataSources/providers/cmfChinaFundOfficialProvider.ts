import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface CmfChinaNotice {
  adId: string;
  title: string;
  publishedAt: string | null;
  detailUrl: string;
}

export class CmfChinaFundOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.cmfchina.com";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly maxDetailFetches = Number(process.env.FUNDSENTINEL_CMFCHINA_DETAIL_FETCH_COUNT ?? 3)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "cmfchina-fund-official",
      source_name: "招商基金官网官方公告 Provider",
      source_type: "fund_report",
      trust_level: "A",
      enabled: true,
      priority: 16,
      access_method: "official fund company website: https://www.cmfchina.com/web/fundDetail/{fund_code}/index.html",
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
      freshness_policy: "official company notices are fresh within 150 days and acceptable within 240 days",
      notes: "Parses CMF China official fund detail pages for product notices and report-notice evidence. It records provenance but does not pretend prompt notices are full report bodies."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_reports", "fund_meta", "current_nav"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const url = this.fundDetailUrl(input.fund_code);
    try {
      const response = await this.fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
      if (!response.ok) return this.failure(info, `HTTP ${response.status}`, [`招商基金官网基金详情页返回 HTTP ${response.status}。`], url);

      const html = await response.text();
      const parsed = CmfChinaFundOfficialProvider.parseFundDetailPage(html, input.fund_code);
      if (!parsed.fundName && !parsed.notices.length) {
        return this.failure(info, "Fund not found on CMF China official website", ["招商基金官网未返回可验证的基金详情或公告列表。"], url);
      }

      const warnings = [
        "招商基金官网是基金公司官方来源；当前 provider 记录公告和报告提示证据，报告全文仍需继续接入证监会基金电子披露或官方 PDF 正文解析。"
      ];
      const detailNotices = await this.fetchNoticeDetails(
        parsed.notices.filter((notice) => this.isReportLike(notice.title)).slice(0, Math.max(0, this.maxDetailFetches)),
        warnings
      );
      const documents = parsed.notices.map((notice) => this.documentFor(notice, detailNotices.get(notice.adId)));
      const latestDate = documents.map((document) => document.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate ?? undefined);
      if (!documents.some((document) => document.document_kind === "periodic_report" || document.document_kind === "report_notice")) {
        warnings.push("招商基金官网公告列表未识别到定期报告或报告提示公告。");
      }
      if (freshness === "stale") warnings.push("招商基金官网最新公告较旧，强结论应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          fund_name: parsed.fundName,
          fund_type: parsed.fundType,
          current_nav: parsed.currentNav,
          daily_return: parsed.dailyReturn,
          nav_history: parsed.navHistory,
          nav_history_dates: parsed.navHistoryDates,
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents.slice(0, 5).map((document) => `招商基金官网公告：${document.title}（${document.published_at ?? "日期未知"}）`)
        },
        raw_reference: url,
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
        ["招商基金官网官方公告抓取失败，应保留官方 fund_reports 缺口并尝试证监会/巨潮/其他基金公司 provider。"],
        url
      );
    }
  }

  static parseFundDetailPage(html: string, fundCode: string): {
    fundName?: string;
    fundType?: string;
    currentNav?: number;
    currentNavDate?: string;
    dailyReturn?: number;
    navHistory?: number[];
    navHistoryDates?: string[];
    notices: CmfChinaNotice[];
  } {
    if (!html.includes(fundCode)) return { notices: [] };

    const fundName = this.firstMatch(html, /<h5>([^<]+)<\/h5>\s*<a class="type_switch"/u);
    const tagMatches = [...html.matchAll(/<span class="fund_tag(?: hover)?">([^<\s]+)[\s\S]*?<\/span>/gu)].map((match) => this.stripHtml(match[1] ?? ""));
    const fundType = tagMatches.find((tag) => /型$/u.test(tag) && !/风险/u.test(tag));
    const navBlock = /<div class="num"><strong>([\d.]+)<\/strong><\/div><p>单位净值(?:\((\d{4}-\d{2}-\d{2})\))?/u.exec(html);
    const navText = navBlock?.[1];
    const currentNavDate = navBlock?.[2];
    const dailyReturnText = this.firstMatch(html, /<div class="color_(?:green|red) num"><strong>([-+]?\d+(?:\.\d+)?)%<\/strong><\/div><p>日涨幅/u);
    const currentNav = this.numberOrUndefined(navText);
    const dailyReturn = this.numberOrUndefined(dailyReturnText);
    const navHistoryRows = this.parseSsrNavHistory(html, fundCode, currentNav, currentNavDate);

    return {
      fundName,
      fundType,
      currentNav,
      currentNavDate,
      dailyReturn,
      navHistory: navHistoryRows.map((row) => row.nav),
      navHistoryDates: navHistoryRows.map((row) => row.date),
      notices: this.parseNoticeList(html)
    };
  }

  static parseNoticeList(html: string): CmfChinaNotice[] {
    const notices = new Map<string, CmfChinaNotice>();
    const noticePattern =
      /<a class="item" href="(\/web\/noticedetails\/(\d+)\/index\.html)" target="_blank"><p>([^<]+)<\/p><span class="date">([^<]+)<\/span>/gu;

    for (const match of html.matchAll(noticePattern)) {
      const path = match[1];
      const adId = match[2];
      const title = this.stripHtml(match[3] ?? "");
      const publishedAt = this.stripHtml(match[4] ?? "") || null;
      if (!path || !adId || !title) continue;
      notices.set(adId, {
        adId,
        title,
        publishedAt,
        detailUrl: `${this.baseUrl}${path}`
      });
    }

    return [...notices.values()];
  }

  static parseNoticeDetailPage(html: string): { title?: string; publishedAt?: string; mentionsCsrcEid: boolean; mentionsCompanyWebsite: boolean } {
    const title = this.firstMatch(html, /<h2>([^<]+)<\/h2>/u);
    const publishedAt = this.firstMatch(html, /<div[^>]*class="data"[^>]*>([^<]+)<\/div>/u);
    return {
      title,
      publishedAt,
      mentionsCsrcEid: /eid\.csrc\.gov\.cn\/fund/u.test(html),
      mentionsCompanyWebsite: /cmfchina\.com/u.test(html) || /本公司网站/u.test(html)
    };
  }

  static parseSsrNavHistory(
    html: string,
    fundCode: string,
    currentNav?: number,
    currentNavDate?: string
  ): Array<{ date: string; nav: number }> {
    const keyIndex = html.indexOf(`"fundNavPage-${fundCode}`);
    if (keyIndex < 0) return currentNav !== undefined && currentNavDate ? [{ date: currentNavDate, nav: currentNav }] : [];

    const beforeKey = html.slice(0, keyIndex);
    const listStart = beforeKey.lastIndexOf(".list=[");
    if (listStart < 0) return currentNav !== undefined && currentNavDate ? [{ date: currentNavDate, nav: currentNav }] : [];

    const arrayStart = listStart + ".list=".length;
    const arrayEnd = beforeKey.indexOf("];", arrayStart);
    if (arrayEnd < 0) return currentNav !== undefined && currentNavDate ? [{ date: currentNavDate, nav: currentNav }] : [];

    const rows = new Map<string, number>();
    if (currentNav !== undefined && currentNavDate) rows.set(currentNavDate, currentNav);

    const arrayText = beforeKey.slice(arrayStart, arrayEnd + 1);
    const objectPattern = /\{valueId:[\s\S]*?\}/gu;
    for (const match of arrayText.matchAll(objectPattern)) {
      const objectText = match[0] ?? "";
      const date = this.navDateFor(objectText, currentNavDate);
      const nav = this.navValueFor(objectText, currentNav);
      if (date && nav !== undefined) rows.set(date, nav);
    }

    return [...rows.entries()]
      .map(([date, nav]) => ({ date, nav }))
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  private async fetchNoticeDetails(
    notices: CmfChinaNotice[],
    warnings: string[]
  ): Promise<Map<string, ReturnType<typeof CmfChinaFundOfficialProvider.parseNoticeDetailPage>>> {
    const detailMap = new Map<string, ReturnType<typeof CmfChinaFundOfficialProvider.parseNoticeDetailPage>>();
    await Promise.all(
      notices.map(async (notice) => {
        try {
          const response = await this.fetchWithTimeout(notice.detailUrl, { headers: this.headers() }, Math.min(this.timeoutMs, 5000));
          if (!response.ok) return;
          detailMap.set(notice.adId, CmfChinaFundOfficialProvider.parseNoticeDetailPage(await response.text()));
        } catch (error) {
          warnings.push(`招商基金官网公告详情抓取失败：${notice.adId} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
    return detailMap;
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

  private documentFor(
    notice: CmfChinaNotice,
    detail?: ReturnType<typeof CmfChinaFundOfficialProvider.parseNoticeDetailPage>
  ): FundReportDocument {
    const title = detail?.title ?? notice.title;
    return {
      title,
      announcement_id: notice.adId,
      published_at: detail?.publishedAt ?? notice.publishedAt,
      category: null,
      document_kind: this.documentKindFor(title, detail),
      detail_url: notice.detailUrl,
      pdf_url: null,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "招商基金官网",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private documentKindFor(title: string, _detail?: ReturnType<typeof CmfChinaFundOfficialProvider.parseNoticeDetailPage>): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告/u.test(title) && /提示性公告/u.test(title)) return "report_notice";
    if (/季度报告|年度报告|中期报告/u.test(title)) return "periodic_report";
    if (/销售文件|招募说明书|基金合同|托管协议|产品资料概要/u.test(title)) return "sales_document";
    if (/公告/u.test(title)) return "business_notice";
    return "other";
  }

  private isReportLike(title: string): boolean {
    return /季度报告|年度报告|中期报告|报告提示/u.test(title);
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""}`;
  }

  private fundDetailUrl(fundCode: string): string {
    return `${CmfChinaFundOfficialProvider.baseUrl}/web/fundDetail/${fundCode}/index.html`;
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)"
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
    if (ageDays <= 150) return "fresh";
    if (ageDays <= 240) return "acceptable";
    return "stale";
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static stripHtml(value: string): string {
    return value.replace(/<[^>]+>/gu, "").replace(/&nbsp;/gu, " ").trim();
  }

  private static numberOrUndefined(value?: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static navDateFor(objectText: string, currentNavDate?: string): string | undefined {
    const literal = /navDate:"(\d{4}-\d{2}-\d{2})"/u.exec(objectText)?.[1];
    if (literal) return literal;
    if (/navDate:j(?:,|\})/u.test(objectText)) return currentNavDate;
    return undefined;
  }

  private static navValueFor(objectText: string, currentNav?: number): number | undefined {
    const literal = /relatePrice:"([\d.]+)"/u.exec(objectText)?.[1];
    if (literal) return this.numberOrUndefined(literal);
    if (/relatePrice:E(?:,|\})/u.test(objectText)) return currentNav;
    return undefined;
  }
}
