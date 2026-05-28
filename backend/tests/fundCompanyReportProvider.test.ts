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
