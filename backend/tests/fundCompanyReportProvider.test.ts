import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { FundCompanyReportProvider, SourceRegistry } from "../src/dataSources/index.js";
import type { DataProvider, DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../src/dataSources/index.js";
import type { FundReportDocument } from "../src/schemas/index.js";

const verifiedOfficialReport: FundReportDocument = {
  title: "招商信用增强债券型证券投资基金2026年第1季度报告",
  announcement_id: "official-2026q1",
  published_at: "2026-04-22",
  category: null,
  document_kind: "periodic_report",
  detail_url: "https://www.cmfchina.com/web/noticedetails/223999/index.html",
  pdf_url: "https://www.cmfchina.com/upload/report/007951-2026q1.pdf",
  pdf_verified: true,
  pdf_content_type: "application/pdf",
  pdf_content_length: 345678,
  source_name: "招商基金官网",
  source_type: "official_disclosure",
  trust_level: "A"
};

const unverifiedOfficialReport: FundReportDocument = {
  ...verifiedOfficialReport,
  announcement_id: "official-unverified-2026q1",
  pdf_verified: false,
  pdf_content_type: null,
  pdf_content_length: null
};

test("FundCompanyReportProvider filters verified official periodic reports", () => {
  const documents = FundCompanyReportProvider.verifiedOfficialPeriodicReports([
    unverifiedOfficialReport,
    {
      ...verifiedOfficialReport,
      announcement_id: "official-missing-pdf-metadata",
      pdf_content_type: null,
      pdf_content_length: null
    },
    {
      ...verifiedOfficialReport,
      announcement_id: "aggregator-2026q1",
      source_type: "aggregator_index",
      source_name: "东方财富"
    },
    verifiedOfficialReport
  ]);

  assert.deepEqual(
    documents.map((document) => document.announcement_id),
    ["official-2026q1"]
  );
});

test("FundCompanyReportProvider coordinates existing verified official report evidence", async () => {
  const provider = new FundCompanyReportProvider();
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false,
    context: {
      fund_code: "007951",
      fund_report_documents: [verifiedOfficialReport]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "fund-company-report");
  assert.equal(result.trust_level, "A");
  assert.equal(result.data?.fund_report_documents?.[0]?.announcement_id, "official-2026q1");
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("pdf_verified=true"));
  assert.ok(result.data?.news_summaries?.[0]?.includes("官方定期报告已校验"));
  assert.equal(result.raw_reference, "https://www.cmfchina.com/web/noticedetails/223999/index.html");
  assert.ok(result.warnings.some((warning) => warning.includes("不解析 PDF 正文")));
});

test("FundCompanyReportProvider fails explicitly when no verified official report exists", async () => {
  const provider = new FundCompanyReportProvider();
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false,
    context: {
      fund_code: "007951",
      fund_report_documents: [unverifiedOfficialReport]
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.match(result.error ?? "", /No verified official periodic report/);
  assert.ok(result.warnings.some((warning) => warning.includes("FUNDSENTINEL_MANUAL_REPORT_DIR")));
  assert.equal(result.raw_reference, "https://www.cmfchina.com/web/noticedetails/223999/index.html");
});

test("Argus surfaces fund-company report coordination gaps in DataGapReport details", async () => {
  const registry = new SourceRegistry({
    providers: [new UnverifiedOfficialReportContextProvider(), new FundCompanyReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("fund-company-report-gap", "007951");
  const detail = dataPack.data_gap_report?.failed_source_details.find((source) => source.source_id === "fund-company-report");

  assert.ok(detail);
  assert.match(detail.error ?? "", /No verified official periodic report/);
  assert.ok(detail.warnings.some((warning) => warning.includes("具体基金公司官网")));
  assert.equal(detail.raw_reference, "https://www.cmfchina.com/web/noticedetails/223999/index.html");
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"));
});

test("Argus does not count report coordinator as an external authoritative source", async () => {
  const registry = new SourceRegistry({
    providers: [new ReportDocumentContextProvider("verified-report-context", verifiedOfficialReport), new FundCompanyReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("fund-company-report-composition", "007951");
  const composition = dataPack.data_quality_report.source_composition;

  assert.equal(dataPack.data_sources.some((source) => source.source_id === "fund-company-report" && source.success), true);
  assert.ok(composition.authoritative.includes("verified-report-context"));
  assert.equal(composition.authoritative.includes("fund-company-report"), false);
  assert.equal(dataPack.data_quality_report.authoritative_source_count, 1);
  assert.equal(composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
});

test("Argus does not let manual report fallback satisfy coordinator official coverage", async () => {
  const registry = new SourceRegistry({
    providers: [new ManualReportDocumentContextProvider(), new FundCompanyReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("manual-report-context", "007951");
  const composition = dataPack.data_quality_report.source_composition;

  assert.equal(dataPack.fund_report_documents.some((document) => document.announcement_id === "official-2026q1"), true);
  assert.equal(dataPack.data_sources.some((source) => source.source_id === "manual-report-context" && source.success), true);
  assert.equal(dataPack.data_sources.some((source) => source.source_id === "fund-company-report" && !source.success), true);
  assert.equal(composition.manual.includes("manual-report-context"), true);
  assert.equal(composition.authoritative.includes("fund-company-report"), false);
  assert.equal(composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("fund_reports"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
});

test("Argus prefers automated official report documents over manual fallback duplicates", async () => {
  const manualDocument: FundReportDocument = {
    ...verifiedOfficialReport,
    detail_url: "manual://operator/007951-2026q1",
    pdf_url: "manual://operator/007951-2026q1.pdf",
    source_name: "人工官方报告导入"
  };
  const registry = new SourceRegistry({
    providers: [new ManualReportDocumentContextProvider(manualDocument), new ReportDocumentContextProvider("verified-report-context", verifiedOfficialReport)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("manual-plus-automated-report-context", "007951");
  const document = dataPack.fund_report_documents.find((item) => item.announcement_id === "official-2026q1");

  assert.equal(dataPack.data_quality_report.source_composition.manual.includes("manual-report-context"), true);
  assert.equal(dataPack.data_quality_report.source_composition.authoritative.includes("verified-report-context"), true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(document?.detail_url, verifiedOfficialReport.detail_url);
  assert.equal(document?.pdf_url, verifiedOfficialReport.pdf_url);
  assert.equal(document?.source_name, verifiedOfficialReport.source_name);
  assert.equal(dataPack.fund_report_documents.filter((item) => item.announcement_id === "official-2026q1").length, 1);
});

test("SourceRegistry cache keys include official report document context", async () => {
  const input = {
    fund_code: "CACHE-SIG-001",
    required_data: ["fund_reports", "cache_signature_test"],
    demo_mode: false
  };
  const firstRegistry = new SourceRegistry({
    providers: [new ReportDocumentContextProvider("verified-report-cache-context", verifiedOfficialReport), new FundCompanyReportProvider()],
    cacheTtlMs: 60_000,
    retryCount: 0,
    shareState: true
  });
  const secondRegistry = new SourceRegistry({
    providers: [new ReportDocumentContextProvider("unverified-report-cache-context", unverifiedOfficialReport), new FundCompanyReportProvider()],
    cacheTtlMs: 60_000,
    retryCount: 0,
    shareState: true
  });

  const firstReportResult = (await firstRegistry.fetchAll(input)).find((result) => result.source_id === "fund-company-report");
  const secondReportResult = (await secondRegistry.fetchAll(input)).find((result) => result.source_id === "fund-company-report");

  assert.equal(firstReportResult?.success, true);
  assert.equal(firstReportResult?.cache_hit, false);
  assert.equal(secondReportResult?.success, false);
  assert.equal(secondReportResult?.cache_hit, false);
  assert.match(secondReportResult?.error ?? "", /No verified official periodic report/);
});

test("default SourceRegistry runs report coordinator after automated official report providers and before manual fallback", () => {
  const sources = new SourceRegistry({ enableLiveProviders: false }).providerCandidates();
  const priorityFor = (sourceId: string) => sources.find((source) => source.source_id === sourceId)?.priority ?? Number.NaN;

  assert.ok(priorityFor("fund-company-report") > priorityFor("sec-edgar"));
  assert.ok(priorityFor("fund-company-report") > priorityFor("cninfo-report"));
  assert.ok(priorityFor("fund-company-report") > priorityFor("csrc-fund-disclosure"));
  assert.ok(priorityFor("manual-official-report-import") > priorityFor("fund-company-report"));
});

class ManualReportDocumentContextProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(private readonly reportDocument: FundReportDocument = verifiedOfficialReport) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "manual-report-context",
      source_name: "Manual Report Context Provider",
      source_type: "manual_import",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test fixture",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "manual-report-context",
      source_name: "Manual Report Context Provider",
      source_type: "manual_import",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "招商信用增强债券C",
        fund_report_documents: [this.reportDocument],
        manual_report_import_audit: {
          manifest_path: "/tmp/fundsentinel/manual-reports/manifest.json",
          manifest_sha256: "0".repeat(64),
          manifest_size_bytes: 1024,
          manifest_mtime: "2026-05-28T00:00:00.000Z",
          report_count: 1,
          verified_pdf_count: 1,
          latest_report_date: "2026-04-22",
          imported_at: "2026-05-28T00:00:00.000Z",
          reports: [
            {
              announcement_id: "official-2026q1",
              source_url: this.reportDocument.detail_url ?? "",
              pdf_path: "/tmp/fundsentinel/manual-reports/007951-2026q1.pdf",
              pdf_sha256: "1".repeat(64),
              pdf_size_bytes: 345678
            }
          ]
        }
      },
      raw_reference: "/tmp/fundsentinel/manual-reports/manifest.json",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: ["人工导入报告只能作为显式兜底，不计入自动官方覆盖。"],
      error: null,
      is_demo: false
    };
  }
}

class UnverifiedOfficialReportContextProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "unverified-report-context",
      source_name: "Unverified Report Context Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test fixture",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "unverified-report-context",
      source_name: "Unverified Report Context Provider",
      source_type: "fund_company",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "招商信用增强债券C",
        current_nav: 1.0799,
        nav_history: [1.0801, 1.0799],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        fund_report_documents: [unverifiedOfficialReport]
      },
      raw_reference: "https://www.cmfchina.com/web/noticedetails/223999/index.html",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class ReportDocumentContextProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly sourceId: string,
    private readonly reportDocument: FundReportDocument
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: this.sourceId,
      source_name: this.sourceId,
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test fixture",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: this.sourceId,
      source_name: this.sourceId,
      source_type: "fund_company",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "Cache Signature Test Fund",
        current_nav: 1.0799,
        nav_history: [1.0801, 1.0799],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        fund_report_documents: [this.reportDocument]
      },
      raw_reference: this.reportDocument.detail_url,
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}
