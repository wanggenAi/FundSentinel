import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export class CsrcFundDisclosureProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "http://eid.csrc.gov.cn";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly endpointTemplates: string[] = ["http://eid.csrc.gov.cn/fund", "http://eid.csrc.gov.cn/fund/"]
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "csrc-fund-disclosure",
      source_name: "CSRC Fund E-Disclosure Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      enabled: true,
      priority: 4,
      access_method: "official fund disclosure site probe/parser: http://eid.csrc.gov.cn/fund",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      freshness_policy: "official periodic fund reports are fresh within 150 days and acceptable within 240 days",
      notes:
        "Attempts the CSRC fund e-disclosure entrypoint and parses official periodic-report links when available. If the official site blocks automation, the failure is surfaced as a data gap."
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

    const warnings: string[] = [];
    const failures: string[] = [];
    let lastReference: string | null = null;
    for (const url of this.urlsFor(input.fund_code)) {
      lastReference = url;
      try {
        const response = await this.fetchWithTimeout(url, { headers: this.headers() }, this.timeoutMs);
        const text = await response.text();
        if (!response.ok) {
          failures.push(`${url} HTTP ${response.status}`);
          warnings.push(`证监会基金电子披露入口返回 HTTP ${response.status}。`);
          continue;
        }
        if (CsrcFundDisclosureProvider.isBlockedPage(text)) {
          failures.push(`${url} blocked by site protection`);
          warnings.push("证监会基金电子披露入口疑似触发站点防护，不能将其视为可用数据源。");
          continue;
        }

        const documents = CsrcFundDisclosureProvider.parseDisclosurePage(text, input.fund_code, url);
        if (!documents.length) {
          failures.push(`${url} reachable but no fund-specific periodic report links parsed`);
          warnings.push("证监会基金电子披露入口可访问，但未解析到该基金的官方定期报告链接。");
          continue;
        }

        const latestDate = documents.map((document) => document.published_at).filter(Boolean).sort().at(-1);
        const freshness = this.freshnessFor(latestDate ?? undefined);
        if (freshness === "stale") warnings.push("证监会基金电子披露最新定期报告较旧，强结论应降级。");

        return {
          source_id: info.source_id,
          source_name: info.source_name,
          source_type: info.source_type,
          trust_level: info.trust_level,
          data_status: "partial",
          success: true,
          data: {
            fund_code: input.fund_code,
            fund_report_refs: documents.map((document) => this.reportRefFor(document)),
            fund_report_documents: documents,
            news_summaries: documents
              .slice(0, 5)
              .map((document) => `证监会基金电子披露官方报告：${document.title}（${document.published_at ?? "日期未知"}）`)
          },
          raw_reference: url,
          fetched_at: nowIso(),
          freshness,
          warnings,
          error: null,
          is_demo: false
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${url} ${message}`);
        warnings.push(`证监会基金电子披露 provider 抓取失败：${message}。`);
      }
    }

    return this.failure(
      info,
      failures.length ? failures.join(" | ") : "No CSRC fund disclosure endpoint could be queried",
      [
        ...warnings,
        "Argus 已记录官方披露缺口。建议继续实现受站点规则允许的查询 endpoint、运营导入官方报告 PDF，或接入具备授权的披露数据 API。"
      ],
      lastReference
    );
  }

  static parseDisclosurePage(html: string, fundCode: string, pageUrl = CsrcFundDisclosureProvider.baseUrl): FundReportDocument[] {
    const documents = new Map<string, FundReportDocument>();
    const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;

    for (const match of html.matchAll(anchorPattern)) {
      const href = match[1];
      const title = this.stripHtml(match[2] ?? "");
      if (!href || !title || !this.isFundSpecific(title, href, fundCode) || !this.isReportLike(title)) continue;

      const documentKind = this.documentKindFor(title);
      const absoluteUrl = this.absoluteUrl(href, pageUrl);
      const isPdf = /\.pdf(?:[?#].*)?$/iu.test(absoluteUrl);
      const document: FundReportDocument = {
        title,
        announcement_id: this.announcementIdFor(href, title),
        published_at: this.publishedAtFor(title),
        category: null,
        document_kind: documentKind,
        detail_url: absoluteUrl,
        pdf_url: isPdf ? absoluteUrl : null,
        pdf_verified: false,
        pdf_content_type: null,
        pdf_content_length: null,
        source_name: "中国证监会基金电子披露网站",
        source_type: "official_disclosure",
        trust_level: "A"
      };
      documents.set(document.announcement_id || document.title, document);
    }

    return [...documents.values()];
  }

  static isBlockedPage(html: string): boolean {
    return /访问被阻断|request has been blocked|potential threats|<title>405<\/title>/iu.test(html);
  }

  private urlsFor(fundCode: string): string[] {
    return this.endpointTemplates.map((template) => template.replaceAll("{fund_code}", fundCode));
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} kind=${document.document_kind} url=${document.detail_url ?? ""}`;
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
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 150) return "fresh";
    if (ageDays <= 240) return "acceptable";
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

  private static isFundSpecific(title: string, href: string, fundCode: string): boolean {
    return title.includes(fundCode) || href.includes(fundCode);
  }

  private static isReportLike(title: string): boolean {
    return /季度报告|年度报告|中期报告/u.test(title);
  }

  private static documentKindFor(title: string): FundReportDocument["document_kind"] {
    if (/季度报告|年度报告|中期报告/u.test(title) && /提示性公告/u.test(title)) return "report_notice";
    if (/季度报告|年度报告|中期报告/u.test(title)) return "periodic_report";
    if (/销售文件|招募说明书|基金合同|托管协议|产品资料概要/u.test(title)) return "sales_document";
    if (/公告/u.test(title)) return "business_notice";
    return "other";
  }

  private static publishedAtFor(text: string): string | null {
    const normalized = text.replace(/[年月]/gu, "-").replace(/日/gu, "");
    const match = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u.exec(normalized);
    if (!match) return null;
    const [, year, month, day] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  private static announcementIdFor(href: string, title: string): string {
    if (href.trim()) return href.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 120);
    return title.replace(/\s+/gu, "-").slice(0, 80);
  }

  private static absoluteUrl(href: string, pageUrl: string): string {
    try {
      return new URL(href, pageUrl || CsrcFundDisclosureProvider.baseUrl).toString();
    } catch {
      return href;
    }
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
