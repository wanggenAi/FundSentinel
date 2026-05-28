import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface CninfoFundSecurity {
  code: string;
  pinyin?: string;
  category?: string;
  orgId: string;
  zwjc: string;
}

interface CninfoAnnouncement {
  secCode?: string;
  secName?: string;
  orgId?: string;
  announcementId?: string;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
  adjunctSize?: number;
  adjunctType?: string;
  pageColumn?: string;
  shortTitle?: string;
}

interface CninfoAnnouncementResponse {
  announcements?: CninfoAnnouncement[] | null;
  totalAnnouncement?: number;
  totalRecordNum?: number;
}

export class CninfoReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.cninfo.com.cn";
  private static readonly staticBaseUrl = "https://static.cninfo.com.cn";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly verifyPdfCount = Number(process.env.FUNDSENTINEL_CNINFO_VERIFY_COUNT ?? 3),
    private readonly reportSearchKeywords = ["季度报告", "年度报告", "中期报告"]
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "cninfo-report",
      source_name: "CNInfo Official Fund Disclosure Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      enabled: true,
      priority: 5,
      access_method: "official CNInfo fund disclosure endpoints: /new/data/fund_stock.json and /new/hisAnnouncement/query",
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
      freshness_policy: "official disclosure PDFs are fresh within 150 days and acceptable within 240 days",
      notes:
        "Fetches CNInfo's official fund security list, then queries fund disclosure announcements and verifies PDF metadata. Coverage is strongest for listed funds such as ETF/LOF/closed-end funds."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_reports", "holdings", "fund_meta"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const warnings: string[] = [];
    const securityListUrl = `${CninfoReportProvider.baseUrl}/new/data/fund_stock.json`;
    try {
      const securityResponse = await this.fetchWithTimeout(securityListUrl, { headers: this.headers() }, this.timeoutMs);
      if (!securityResponse.ok) {
        return this.failure(info, `fund_stock.json HTTP ${securityResponse.status}`, [`巨潮资讯基金证券列表返回 HTTP ${securityResponse.status}。`], securityListUrl);
      }

      const security = CninfoReportProvider.findFundSecurity(await securityResponse.text(), input.fund_code);
      if (!security) {
        return this.failure(
          info,
          `Fund ${input.fund_code} not found in CNInfo fund security list`,
          [
            "巨潮资讯基金证券列表未收录该基金代码；这通常意味着该开放式基金不属于巨潮当前 fund_stock 覆盖范围。",
            "Argus 不会用关键词全站搜索替代精确代码匹配，以免误匹配其他基金公告。"
          ],
          securityListUrl
        );
      }

      const queryUrl = `${CninfoReportProvider.baseUrl}/new/hisAnnouncement/query`;
      const parsed = await this.fetchAnnouncements(queryUrl, security, input.fund_code, warnings);
      if (!parsed.length) {
        return this.failure(
          info,
          "CNInfo returned no fund-specific periodic report announcements",
          ["巨潮资讯公告查询可访问，但未返回该基金的定期报告 PDF 元数据。"],
          queryUrl
        );
      }

      const documents = parsed.map((announcement) => this.documentFor(announcement));
      await this.verifyPdfDocuments(documents, warnings);
      const latestDate = documents.map((document) => document.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate ?? undefined);
      if (freshness === "stale") warnings.push("巨潮资讯最新定期报告较旧，强结论应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          fund_name: security.zwjc,
          fund_type: security.category,
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: documents
            .slice(0, 5)
            .map((document) => `巨潮资讯官方基金公告：${document.title}（${document.published_at ?? "日期未知"}）`)
        },
        raw_reference: queryUrl,
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
        ["巨潮资讯官方披露 provider 抓取失败；Argus 应保留 official_fund_reports 缺口并尝试证监会、基金公司官网或人工导入官方 PDF。"],
        securityListUrl
      );
    }
  }

  static findFundSecurity(text: string, fundCode: string): CninfoFundSecurity | null {
    const parsed = JSON.parse(text) as { stockList?: CninfoFundSecurity[] };
    return parsed.stockList?.find((security) => security.code === fundCode) ?? null;
  }

  static parseAnnouncementResponse(text: string, fundCode: string): CninfoAnnouncement[] {
    const parsed = JSON.parse(text) as CninfoAnnouncementResponse;
    return (parsed.announcements ?? []).filter(
      (announcement) =>
        announcement.secCode === fundCode &&
        Boolean(announcement.announcementId) &&
        Boolean(announcement.adjunctUrl) &&
        this.isReportLike(this.stripHtml(announcement.announcementTitle ?? ""))
    );
  }

  private async fetchAnnouncements(
    queryUrl: string,
    security: CninfoFundSecurity,
    fundCode: string,
    warnings: string[]
  ): Promise<CninfoAnnouncement[]> {
    const announcements = new Map<string, CninfoAnnouncement>();
    for (const keyword of this.reportSearchKeywords) {
      const response = await this.fetchWithTimeout(
        queryUrl,
        {
          method: "POST",
          headers: { ...this.headers(), "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: this.queryBodyFor(security, keyword)
        },
        this.timeoutMs
      );
      if (!response.ok) {
        warnings.push(`巨潮资讯公告查询 keyword=${keyword} 返回 HTTP ${response.status}。`);
        continue;
      }
      for (const announcement of CninfoReportProvider.parseAnnouncementResponse(await response.text(), fundCode)) {
        announcements.set(announcement.announcementId ?? `${announcement.secCode}:${announcement.announcementTitle}`, announcement);
      }
    }
    return [...announcements.values()].sort((left, right) => (right.announcementTime ?? 0) - (left.announcementTime ?? 0));
  }

  private queryBodyFor(security: CninfoFundSecurity, searchkey: string): URLSearchParams {
    return new URLSearchParams({
      pageNum: "1",
      pageSize: "20",
      column: "fund",
      tabName: "fulltext",
      plate: "",
      stock: `${security.code},${security.orgId}`,
      searchkey,
      secid: "",
      category: "",
      trade: "",
      seDate: "",
      sortName: "",
      sortType: "",
      isHLtitle: "true"
    });
  }

  private documentFor(announcement: CninfoAnnouncement): FundReportDocument {
    const adjunctUrl = announcement.adjunctUrl ?? "";
    const absolutePdfUrl = this.absolutePdfUrl(adjunctUrl);
    const title = CninfoReportProvider.stripHtml(announcement.announcementTitle ?? announcement.shortTitle ?? "untitled");
    return {
      title,
      announcement_id: announcement.announcementId ?? adjunctUrl,
      published_at: this.dateFor(announcement.announcementTime, adjunctUrl),
      category: announcement.pageColumn ?? null,
      document_kind: this.documentKindFor(title),
      detail_url: `${CninfoReportProvider.baseUrl}/new/disclosure/detail?stockCode=${announcement.secCode ?? ""}&announcementId=${announcement.announcementId ?? ""}`,
      pdf_url: absolutePdfUrl,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: typeof announcement.adjunctSize === "number" ? announcement.adjunctSize * 1024 : null,
      source_name: "巨潮资讯网",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private async verifyPdfDocuments(documents: FundReportDocument[], warnings: string[]): Promise<void> {
    const candidates = documents.filter((document) => document.pdf_url).slice(0, Math.max(0, this.verifyPdfCount));
    await Promise.all(
      candidates.map(async (document) => {
        try {
          const response = await this.fetchWithTimeout(document.pdf_url!, { method: "HEAD", headers: this.headers() }, Math.min(this.timeoutMs, 5000));
          const contentType = response.headers.get("content-type");
          const contentLength = response.headers.get("content-length");
          document.pdf_verified = response.ok && Boolean(contentType?.toLowerCase().includes("pdf"));
          document.pdf_content_type = contentType;
          document.pdf_content_length = contentLength ? Number(contentLength) : document.pdf_content_length;
          if (!document.pdf_verified) warnings.push(`巨潮资讯 PDF 未通过 HEAD 校验：${document.announcement_id}。`);
        } catch (error) {
          warnings.push(`巨潮资讯 PDF 校验失败：${document.announcement_id} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} pdf=${document.pdf_url ?? ""}`;
  }

  private absolutePdfUrl(adjunctUrl: string): string | null {
    if (!adjunctUrl) return null;
    try {
      return new URL(adjunctUrl, CninfoReportProvider.staticBaseUrl).toString();
    } catch {
      return adjunctUrl;
    }
  }

  private dateFor(timestamp: number | undefined, adjunctUrl: string): string | null {
    if (timestamp && Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
    const match = /finalpage\/(\d{4})-(\d{2})-(\d{2})\//u.exec(adjunctUrl);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  private documentKindFor(title: string): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告/u.test(title) && /提示性公告/u.test(title)) return "report_notice";
    if (/季度报告|年度报告|中期报告/u.test(title)) return "periodic_report";
    if (/销售文件|招募说明书|基金合同|托管协议|产品资料概要/u.test(title)) return "sales_document";
    if (/公告/u.test(title)) return "business_notice";
    return "other";
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 150) return "fresh";
    if (ageDays <= 240) return "acceptable";
    return "stale";
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
      referer: `${CninfoReportProvider.baseUrl}/new/disclosure/fund`,
      accept: "application/json,text/plain,*/*"
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

  private static isReportLike(title: string): boolean {
    return /季度报告|年度报告|中期报告/u.test(title);
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<[^>]*>/gu, "")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/\s+/gu, " ")
      .trim();
  }
}
