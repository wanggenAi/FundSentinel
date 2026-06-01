import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class FundCompanyReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "fund-company-report",
      source_name: "Fund Company Report Evidence Coordinator",
      source_type: "fund_report",
      trust_level: "A",
      enabled: true,
      priority: 52,
      access_method: "context coordinator over official fund-company/regulatory report documents",
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
      freshness_policy: "official periodic report PDF metadata is fresh within 150 days and acceptable within 240 days",
      notes:
        "Coordinates official report evidence already collected by concrete fund-company/regulatory providers. It does not fabricate or crawl unknown company sites."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("fund_reports");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const officialDocuments = FundCompanyReportProvider.verifiedOfficialPeriodicReports(input.context?.fund_report_documents ?? []);
    if (!officialDocuments.length) {
      const warnings = [
        "尚未从具体基金公司官网、证监会、巨潮或人工官方 PDF 导入中取得已校验的官方定期报告 PDF 元数据。",
        "需要为目标基金管理人接入具体官网适配器，或通过 FUNDSENTINEL_MANUAL_REPORT_DIR 导入经校验的官方报告 PDF。"
      ];
      return this.failure(info, "No verified official periodic report documents in provider context", warnings, input.context?.fund_report_documents?.[0]?.detail_url ?? null);
    }

    const latestDate = officialDocuments.map((document) => document.published_at).filter(Boolean).sort().at(-1);
    const freshness = this.freshnessFor(latestDate ?? undefined);
    const warnings = [
      "已复用前序官方 provider 取得并校验的定期报告 PDF 元数据；该协调层不解析 PDF 正文，不补造持仓。"
    ];
    if (freshness === "stale") warnings.push("最新官方定期报告日期偏旧，Logos 必须降级。");

    return {
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_report_refs: officialDocuments.map((document) => this.reportRefFor(document)),
        fund_report_documents: officialDocuments,
        news_summaries: officialDocuments
          .slice(0, 5)
          .map((document) => `官方定期报告已校验：${document.title}（${document.published_at ?? "日期未知"}，${document.source_name}）`)
      },
      raw_reference: officialDocuments[0]?.detail_url ?? officialDocuments[0]?.pdf_url ?? null,
      fetched_at: nowIso(),
      freshness,
      warnings,
      error: null,
      is_demo: false
    };
  }

  static verifiedOfficialPeriodicReports(documents: FundReportDocument[]): FundReportDocument[] {
    return documents
      .filter(
        (document) =>
          document.source_type === "official_disclosure" &&
          document.trust_level === "A" &&
          document.document_kind === "periodic_report" &&
          document.pdf_verified === true &&
          Boolean(document.pdf_url?.trim()) &&
          document.pdf_content_type === "application/pdf" &&
          typeof document.pdf_content_length === "number" &&
          Number.isFinite(document.pdf_content_length) &&
          document.pdf_content_length > 0
      )
      .sort((left, right) => (right.published_at ?? "").localeCompare(left.published_at ?? ""));
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} kind=${document.document_kind} pdf=${document.pdf_url ?? "none"} pdf_verified=${document.pdf_verified} source=${document.source_name}`;
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
}
