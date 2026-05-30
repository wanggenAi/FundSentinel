import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { ManualOfficialReportProvider, SourceRegistry } from "../src/dataSources/index.js";

const pdfBytes = Buffer.from("%PDF-1.4\n% FundSentinel test official report\n%%EOF\n");

async function writeManifest(dir: string, sha256: string): Promise<void> {
  await writeFile(path.join(dir, "007951.reports.json"), JSON.stringify([
    {
      fund_code: "007951",
      title: "招商信用增强债券C2026年第1季度报告",
      announcement_id: "manual-007951-2026q1",
      published_at: "2026-04-22",
      document_kind: "periodic_report",
      source_name: "中国证监会基金电子披露网站",
      source_url: "https://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf",
      pdf_path: "007951-2026q1.pdf",
      pdf_sha256: sha256,
      category: "quarterly_report"
    }
  ]));
}

async function writeManifestWithPdfPath(dir: string, sha256: string, pdfPath: string): Promise<void> {
  await writeFile(path.join(dir, "007951.reports.json"), JSON.stringify([
    {
      fund_code: "007951",
      title: "招商信用增强债券C2026年第1季度报告",
      announcement_id: "manual-007951-2026q1",
      published_at: "2026-04-22",
      document_kind: "periodic_report",
      source_name: "中国证监会基金电子披露网站",
      source_url: "https://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf",
      pdf_path: pdfPath,
      pdf_sha256: sha256,
      category: "quarterly_report"
    }
  ]));
}

function manifestRow(sha256 = "0".repeat(64), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fund_code: "007951",
    title: "招商信用增强债券C2026年第1季度报告",
    announcement_id: "manual-007951-2026q1",
    published_at: "2026-04-22",
    document_kind: "periodic_report",
    source_name: "中国证监会基金电子披露网站",
    source_url: "https://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf",
    pdf_path: "007951-2026q1.pdf",
    pdf_sha256: sha256,
    category: "quarterly_report",
    ...overrides
  };
}

test("ManualOfficialReportProvider imports verified official report PDF metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-manual-report-"));
  try {
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    await writeFile(path.join(dir, "007951-2026q1.pdf"), pdfBytes);
    await writeManifest(dir, sha256);

    const result = await new ManualOfficialReportProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false
    });

    const document = result.data?.fund_report_documents?.[0];
    assert.equal(result.success, true);
    assert.equal(result.source_id, "manual-official-report-import");
    assert.equal(result.source_type, "manual_import");
    assert.equal(result.trust_level, "A");
    assert.equal(result.is_demo, false);
    assert.equal(document?.source_type, "official_disclosure");
    assert.equal(document?.document_kind, "periodic_report");
    assert.equal(document?.pdf_verified, true);
    assert.equal(document?.pdf_content_type, "application/pdf");
    assert.equal(document?.pdf_content_length, pdfBytes.length);
    assert.equal(document?.pdf_sha256, sha256);
    assert.equal(document?.pdf_url, path.join(dir, "007951-2026q1.pdf"));
    assert.ok(result.data?.fund_report_refs?.[0]?.includes("pdf_verified=true"));
    assert.ok(result.data?.fund_report_refs?.[0]?.includes(`sha256=${sha256}`));
    assert.equal(result.data?.manual_report_import_audit?.manifest_path, path.join(dir, "007951.reports.json"));
    assert.equal(result.data?.manual_report_import_audit?.report_count, 1);
    assert.equal(result.data?.manual_report_import_audit?.verified_pdf_count, 1);
    assert.equal(result.data?.manual_report_import_audit?.latest_report_date, "2026-04-22");
    assert.equal(result.data?.manual_report_import_audit?.reports[0]?.pdf_sha256, sha256);
    assert.equal(result.data?.manual_report_import_audit?.reports[0]?.pdf_size_bytes, pdfBytes.length);
    assert.match(result.data?.manual_report_import_audit?.reports[0]?.pdf_mtime ?? "", /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(result.data?.manual_report_import_audit?.manifest_sha256.length, 64);
    assert.ok(result.warnings.some((warning) => warning.includes("不得标记为自动抓取")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualOfficialReportProvider rejects mismatched official PDF hashes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-bad-manual-report-"));
  try {
    await writeFile(path.join(dir, "007951-2026q1.pdf"), pdfBytes);
    await writeManifest(dir, "0".repeat(64));

    const result = await new ManualOfficialReportProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false
    });

    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.match(result.error ?? "", /SHA256 mismatch/);
    assert.ok(result.warnings.some((warning) => warning.includes("校验失败")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualOfficialReportProvider rejects official PDF paths outside the manual report directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-escaped-manual-report-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-outside-manual-report-"));
  try {
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    await writeFile(path.join(outsideDir, "007951-2026q1.pdf"), pdfBytes);
    await writeManifestWithPdfPath(dir, sha256, path.relative(dir, path.join(outsideDir, "007951-2026q1.pdf")));

    const result = await new ManualOfficialReportProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false
    });

    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.match(result.error ?? "", /inside FUNDSENTINEL_MANUAL_REPORT_DIR/);
    assert.ok(result.warnings.some((warning) => warning.includes("校验失败")));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("ManualOfficialReportProvider rejects absolute official PDF paths", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-absolute-manual-report-"));
  try {
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    const pdfPath = path.join(dir, "007951-2026q1.pdf");
    await writeFile(pdfPath, pdfBytes);
    await writeManifestWithPdfPath(dir, sha256, pdfPath);

    const result = await new ManualOfficialReportProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false
    });

    assert.equal(result.success, false);
    assert.equal(result.data, null);
    assert.match(result.error ?? "", /relative and stay inside FUNDSENTINEL_MANUAL_REPORT_DIR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualOfficialReportProvider rejects invalid calendar publication dates", () => {
  assert.throws(
    () =>
      ManualOfficialReportProvider.parseManifest(
        JSON.stringify({
          fund_code: "007951",
          title: "招商信用增强债券C2026年第1季度报告",
          announcement_id: "manual-007951-2026q1",
          published_at: "2026-02-31",
          document_kind: "periodic_report",
          source_name: "中国证监会基金电子披露网站",
          source_url: "https://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf",
          pdf_path: "007951-2026q1.pdf",
          pdf_sha256: "0".repeat(64)
        }),
        "007951"
      ),
    /invalid published_at/
  );
  assert.throws(
    () =>
      ManualOfficialReportProvider.parseManifest(
        JSON.stringify({
          fund_code: "007951",
          title: "招商信用增强债券C2999年第1季度报告",
          announcement_id: "manual-007951-2999q1",
          published_at: "2999-01-01",
          document_kind: "periodic_report",
          source_name: "中国证监会基金电子披露网站",
          source_url: "https://eid.csrc.gov.cn/fund/disclosure/007951/29990101/report.pdf",
          pdf_path: "007951-2999q1.pdf",
          pdf_sha256: "0".repeat(64)
        }),
        "007951"
      ),
    /future published_at/
  );
});

test("ManualOfficialReportProvider deduplicates identical announcement rows and rejects conflicts", () => {
  const duplicateRows = ManualOfficialReportProvider.parseManifest(
    JSON.stringify([manifestRow(), manifestRow()]),
    "007951"
  );
  assert.equal(duplicateRows.length, 1);
  assert.equal(duplicateRows[0]?.announcement_id, "manual-007951-2026q1");

  assert.throws(
    () =>
      ManualOfficialReportProvider.parseManifest(
        JSON.stringify([
          manifestRow(),
          manifestRow("1".repeat(64), {
            pdf_path: "007951-2026q1-replacement.pdf"
          })
        ]),
        "007951"
      ),
    /conflicting rows/
  );
});

test("Argus keeps manual official report import as audited fallback without official core coverage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-argus-manual-report-"));
  try {
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    await writeFile(path.join(dir, "007951-2026q1.pdf"), pdfBytes);
    await writeManifest(dir, sha256);
    const registry = new SourceRegistry({
      providers: [new ManualOfficialReportProvider(dir)],
      cacheTtlMs: 0,
      retryCount: 0
    });

    const { dataPack, result } = await new ArgusAgent(registry).prepareDataPack("manual-official-report-flow", "007951");

    assert.equal(dataPack.is_mock, false);
    assert.equal(result.is_mock, false);
    assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
    assert.equal(dataPack.data_quality_report.source_composition.authoritative.includes("manual-official-report-import"), false);
    assert.equal(dataPack.data_quality_report.authoritative_source_count, 0);
    assert.ok(dataPack.data_quality_report.source_composition.manual.includes("manual-official-report-import"));
    assert.equal(dataPack.data_quality_report.manual_source_count, 1);
    assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("fund_reports"), false);
    assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
    assert.ok(dataPack.data_gap_report?.recommended_solutions.some((solution) => solution.includes("official_fund_reports 缺口要求官方披露定期报告 PDF 通过元数据校验")));
    const manualSource = dataPack.data_sources.find((source) => source.source_id === "manual-official-report-import");
    assert.equal(manualSource?.success, true);
    assert.equal((manualSource?.manual_report_import_audit as { verified_pdf_count?: number } | undefined)?.verified_pdf_count, 1);
    assert.equal((manualSource?.manual_report_import_audit as { reports?: Array<{ pdf_sha256?: string }> } | undefined)?.reports?.[0]?.pdf_sha256, sha256);
    assert.match((manualSource?.manual_report_import_audit as { reports?: Array<{ pdf_mtime?: string }> } | undefined)?.reports?.[0]?.pdf_mtime ?? "", /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(dataPack.allow_downstream_analysis, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualOfficialReportProvider remains available when external live providers are disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-manual-report-disabled-live-"));
  try {
    const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
    await writeFile(path.join(dir, "007951-2026q1.pdf"), pdfBytes);
    await writeManifest(dir, sha256);
    const registry = new SourceRegistry({
      enableLiveProviders: false,
      providers: [new ManualOfficialReportProvider(dir)],
      cacheTtlMs: 0
    });

    const result = (await registry.fetchAll({ fund_code: "007951", required_data: ["fund_reports"], demo_mode: false }))[0];

    assert.equal(result.source_id, "manual-official-report-import");
    assert.equal(result.success, true);
    assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
    assert.equal(result.data?.manual_report_import_audit?.verified_pdf_count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
