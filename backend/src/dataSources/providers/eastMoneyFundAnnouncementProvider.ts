import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface EastMoneyAnnouncement {
  FUNDCODE?: string;
  TITLE?: string;
  ShortTitle?: string;
  NEWCATEGORY?: string;
  PUBLISHDATE?: string;
  PUBLISHDATEDesc?: string;
  ATTACHTYPE?: string;
  ID?: string;
}

export class EastMoneyFundAnnouncementProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly verifyPdfCount = Number(process.env.FUNDSENTINEL_REPORT_VERIFY_COUNT ?? 3)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "eastmoney-fund-announcement",
      source_name: "EastMoney Fund Announcement Provider",
      source_type: "fund_report",
      trust_level: "B",
      enabled: true,
      priority: 14,
      access_method: "public web endpoint: https://api.fund.eastmoney.com/f10/JJGG",
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
      freshness_policy: "latest periodic report announcement is fresh within 150 days and acceptable within 240 days",
      notes: "Fetches Tiantian/EastMoney public fund announcement index for periodic reports; cross-check official PDFs later."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("fund_reports");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const url = this.urlFor(input.fund_code);
    try {
      const response = await this.fetchWithTimeout(url, { headers: this.headers(input.fund_code) }, this.timeoutMs);
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`基金公告接口返回 HTTP ${response.status}。`], url);
      }

      const text = await response.text();
      const parsed = EastMoneyFundAnnouncementProvider.parseAnnouncementData(text);
      if (!parsed.items.length) {
        return this.failure(info, "No fund reports parsed from EastMoney announcement API", ["基金公告接口未返回可解析的定期报告。"], url);
      }

      const latestDate = parsed.items.map((item) => item.PUBLISHDATEDesc ?? item.PUBLISHDATE?.slice(0, 10)).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = ["公告索引来自东方财富/天天基金公开接口，应继续接入基金公司/证监会/巨潮官方披露源交叉验证。"];
      if (freshness === "stale") warnings.push("最新定期报告公告较旧，Logos 必须降级。");
      const documents = parsed.items.map((item) => this.reportDocumentFor(input.fund_code, item));
      await this.verifyPdfDocuments(documents, warnings);

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          fund_name: parsed.items.find((item) => item.ShortTitle)?.ShortTitle,
          fund_report_refs: parsed.items.map((item) => this.reportRefFor(item)),
          fund_report_documents: documents,
          news_summaries: parsed.items.slice(0, 5).map((item) => `定期报告公告：${item.TITLE ?? "未命名公告"}（${item.PUBLISHDATEDesc ?? item.PUBLISHDATE ?? "日期未知"}）`)
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
        ["东方财富/天天基金公告索引抓取失败，Argus 应保留 fund_reports 缺口并尝试官方披露 provider。"],
        url
      );
    }
  }

  static parseAnnouncementData(text: string): { items: EastMoneyAnnouncement[]; totalCount: number } {
    const jsonText = this.stripJsonp(text.trim());
    const parsed = JSON.parse(jsonText) as { Data?: EastMoneyAnnouncement[] | ""; TotalCount?: number };
    return {
      items: Array.isArray(parsed.Data) ? parsed.Data : [],
      totalCount: parsed.TotalCount ?? 0
    };
  }

  private urlFor(fundCode: string): string {
    return `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${fundCode}&pageIndex=1&pageSize=20&type=3`;
  }

  private headers(fundCode: string): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: `https://fundf10.eastmoney.com/jjgg_${fundCode}_3.html`
    };
  }

  private reportRefFor(item: EastMoneyAnnouncement): string {
    const date = item.PUBLISHDATEDesc ?? item.PUBLISHDATE?.slice(0, 10) ?? "unknown-date";
    const id = item.ID ? ` id=${item.ID}` : "";
    const pdf = item.ID && item.ATTACHTYPE === "0" ? ` pdf=${this.pdfUrlFor(item.ID)}` : "";
    return `${date} ${item.TITLE ?? "untitled"}${id}${pdf}`;
  }

  private reportDocumentFor(fundCode: string, item: EastMoneyAnnouncement): FundReportDocument {
    const announcementId = item.ID ?? "unknown-id";
    return {
      title: item.TITLE ?? "untitled",
      announcement_id: announcementId,
      published_at: item.PUBLISHDATEDesc ?? item.PUBLISHDATE?.slice(0, 10) ?? null,
      category: item.NEWCATEGORY ?? null,
      document_kind: "periodic_report",
      detail_url: item.ID ? `https://fund.eastmoney.com/gonggao/${fundCode},${item.ID}.html` : null,
      pdf_url: item.ID && item.ATTACHTYPE === "0" ? this.pdfUrlFor(item.ID) : null,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "EastMoney/Tiantian Fund announcement index",
      source_type: "aggregator_index" as const,
      trust_level: "B" as const
    };
  }

  private pdfUrlFor(announcementId: string): string {
    return `https://pdf.dfcfw.com/pdf/H2_${announcementId}_1.pdf`;
  }

  private async verifyPdfDocuments(
    documents: Array<ReturnType<EastMoneyFundAnnouncementProvider["reportDocumentFor"]>>,
    warnings: string[]
  ): Promise<void> {
    const candidates = documents.filter((document) => document.pdf_url).slice(0, Math.max(0, this.verifyPdfCount));
    await Promise.all(
      candidates.map(async (document) => {
        try {
          const response = await this.fetchWithTimeout(document.pdf_url!, { method: "HEAD", headers: this.pdfHeaders() }, Math.min(this.timeoutMs, 5000));
          const contentType = response.headers.get("content-type");
          const contentLength = response.headers.get("content-length");
          document.pdf_verified = response.ok && Boolean(contentType?.includes("pdf"));
          document.pdf_content_type = contentType;
          document.pdf_content_length = contentLength ? Number(contentLength) : null;
          if (!document.pdf_verified) warnings.push(`报告 PDF 附件未通过 HEAD 校验：${document.announcement_id}。`);
        } catch (error) {
          warnings.push(`报告 PDF 附件校验失败：${document.announcement_id} ${error instanceof Error ? error.message : String(error)}。`);
        }
      })
    );
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

  private pdfHeaders(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: "https://fundf10.eastmoney.com/"
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

  private static stripJsonp(text: string): string {
    const match = /^[\w$]+\(([\s\S]*)\)$/u.exec(text);
    return match ? match[1] : text;
  }
}
