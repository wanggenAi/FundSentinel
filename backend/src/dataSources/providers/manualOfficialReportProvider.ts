import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

interface ManualOfficialReportManifest {
  fund_code: string;
  title: string;
  announcement_id: string;
  published_at: string;
  document_kind: FundReportDocument["document_kind"];
  source_name: string;
  source_url: string;
  pdf_path: string;
  pdf_sha256: string;
  category?: string | null;
}

interface VerifiedManualReport {
  document: FundReportDocument;
  audit: {
    announcement_id: string;
    source_url: string;
    pdf_path: string;
    pdf_sha256: string;
    pdf_size_bytes: number;
  };
}

export class ManualOfficialReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(private readonly dataDir = process.env.FUNDSENTINEL_MANUAL_REPORT_DIR) {}

  sourceInfo(): DataSourceInfo {
    const enabled = Boolean(this.dataDir);
    return {
      source_id: "manual-official-report-import",
      source_name: "Manual Official Report Import Provider",
      source_type: "manual_import",
      trust_level: "A",
      enabled,
      priority: 53,
      access_method: "verified local official PDF manifest via FUNDSENTINEL_MANUAL_REPORT_DIR",
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
      freshness_policy: "official periodic reports are fresh within 150 days and acceptable within 240 days",
      notes:
        "Manual official-report import is a real-data fallback for site-protection or licensed-source gaps. It verifies a local official PDF against a manifest checksum and keeps the source URL."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("fund_reports");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!this.dataDir) {
      return this.failure(info, "FUNDSENTINEL_MANUAL_REPORT_DIR is not configured", ["手动官方报告目录未配置，ManualOfficialReportProvider 不参与业务数据获取。"]);
    }
    if (!/^\d{6}$/u.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const manifestPath = path.join(this.dataDir, `${input.fund_code}.reports.json`);
    try {
      await access(manifestPath);
      const [manifestBuffer, manifestStats] = await Promise.all([readFile(manifestPath), stat(manifestPath)]);
      const manifests = ManualOfficialReportProvider.parseManifest(manifestBuffer.toString("utf8"), input.fund_code);
      if (!manifests.length) {
        return this.failure(info, `No official report manifest entries found for fund ${input.fund_code}`, ["官方报告 manifest 存在，但没有匹配该基金代码的记录。"], manifestPath);
      }

      const verifiedReports = await Promise.all(manifests.map((manifest) => this.documentForManifest(manifest)));
      const documents = verifiedReports.map((report) => report.document);
      const periodicDocuments = documents.filter((document) => document.document_kind === "periodic_report");
      if (!periodicDocuments.length) {
        return this.failure(info, "Manifest did not include any periodic_report document", ["官方报告 manifest 未包含定期报告，不能补齐 official_fund_reports。"], manifestPath);
      }

      const latestDate = documents.map((document) => document.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate ?? undefined);
      const fetchedAt = nowIso();
      const manifestSha256 = createHash("sha256").update(manifestBuffer).digest("hex");
      const reportAudit = {
        manifest_path: manifestPath,
        manifest_sha256: manifestSha256,
        manifest_size_bytes: manifestStats.size,
        manifest_mtime: manifestStats.mtime.toISOString(),
        report_count: documents.length,
        verified_pdf_count: documents.filter((document) => document.pdf_verified).length,
        latest_report_date: latestDate ?? "unknown",
        imported_at: fetchedAt,
        reports: verifiedReports.map((report) => report.audit)
      };
      const warnings = [
        "手动官方报告导入是经人工声明/导入的真实数据 workaround；Argus 必须展示来源 URL、PDF 路径、文件校验和导入时间，不得标记为自动抓取。",
        "该 provider 只校验 PDF 文件存在、PDF 文件头和 manifest SHA256，不解析 PDF 正文；投资结论仍需下游引用报告段落或继续接入全文解析。"
      ];
      if (freshness === "stale") warnings.push("手动导入的官方报告发布日期偏旧，强结论应降级。");

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
          news_summaries: documents.slice(0, 5).map((document) => `人工导入官方报告：${document.title}（${document.published_at ?? "日期未知"}）`),
          manual_report_import_audit: reportAudit
        },
        raw_reference: manifestPath,
        fetched_at: fetchedAt,
        freshness,
        warnings,
        error: null,
        is_demo: false
      };
    } catch (error) {
      return this.failure(
        info,
        error instanceof Error ? error.message : String(error),
        ["手动官方报告 manifest 或 PDF 不可用/校验失败；Argus 应继续保留 official_fund_reports 缺口并提示重新导入官方 PDF。"],
        manifestPath
      );
    }
  }

  static parseManifest(text: string, fundCode: string): ManualOfficialReportManifest[] {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row, index) => this.normalizeManifestRow(row, index)).filter((row) => row.fund_code === fundCode);
  }

  private async documentForManifest(manifest: ManualOfficialReportManifest): Promise<VerifiedManualReport> {
    const pdfPath = path.isAbsolute(manifest.pdf_path) ? manifest.pdf_path : path.join(this.dataDir ?? "", manifest.pdf_path);
    const [pdfBuffer, pdfStats] = await Promise.all([readFile(pdfPath), stat(pdfPath)]);
    if (!pdfBuffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`Official report PDF is not a PDF file: ${pdfPath}`);
    const actualSha256 = createHash("sha256").update(pdfBuffer).digest("hex");
    if (actualSha256 !== manifest.pdf_sha256.toLowerCase()) throw new Error(`Official report PDF SHA256 mismatch for ${manifest.announcement_id}`);

    return {
      document: {
        title: manifest.title,
        announcement_id: manifest.announcement_id,
        published_at: manifest.published_at,
        category: manifest.category ?? null,
        document_kind: manifest.document_kind,
        detail_url: manifest.source_url,
        pdf_url: pdfPath,
        pdf_verified: true,
        pdf_content_type: "application/pdf",
        pdf_content_length: pdfStats.size,
        pdf_sha256: actualSha256,
        source_name: manifest.source_name,
        source_type: "official_disclosure",
        trust_level: "A"
      },
      audit: {
        announcement_id: manifest.announcement_id,
        source_url: manifest.source_url,
        pdf_path: pdfPath,
        pdf_sha256: actualSha256,
        pdf_size_bytes: pdfStats.size
      }
    };
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} source=${document.detail_url ?? ""} pdf=${document.pdf_url ?? ""} pdf_verified=${document.pdf_verified} sha256=${document.pdf_sha256 ?? ""}`;
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(timestamp)) return "unknown";
    const ageDays = (Date.now() - timestamp) / 86_400_000;
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

  private static normalizeManifestRow(row: unknown, index: number): ManualOfficialReportManifest {
    if (!row || typeof row !== "object") throw new Error(`Manifest row ${index + 1} must be an object.`);
    const record = row as Record<string, unknown>;
    const normalized: ManualOfficialReportManifest = {
      fund_code: this.requiredString(record, "fund_code", index),
      title: this.requiredString(record, "title", index),
      announcement_id: this.requiredString(record, "announcement_id", index),
      published_at: this.requiredString(record, "published_at", index),
      document_kind: this.documentKindFor(this.requiredString(record, "document_kind", index), index),
      source_name: this.requiredString(record, "source_name", index),
      source_url: this.requiredUrl(record, "source_url", index),
      pdf_path: this.requiredString(record, "pdf_path", index),
      pdf_sha256: this.requiredSha256(record, "pdf_sha256", index),
      category: typeof record.category === "string" ? record.category : null
    };
    if (!/^\d{6}$/u.test(normalized.fund_code)) throw new Error(`Manifest row ${index + 1} has invalid fund_code.`);
    if (!this.isValidIsoDate(normalized.published_at)) throw new Error(`Manifest row ${index + 1} has invalid published_at.`);
    if (this.isFutureIsoDate(normalized.published_at)) throw new Error(`Manifest row ${index + 1} has future published_at.`);
    return normalized;
  }

  private static requiredString(record: Record<string, unknown>, field: string, index: number): string {
    const value = record[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Manifest row ${index + 1} missing required field: ${field}`);
    return value.trim();
  }

  private static requiredUrl(record: Record<string, unknown>, field: string, index: number): string {
    const value = this.requiredString(record, field, index);
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
      return url.toString();
    } catch {
      throw new Error(`Manifest row ${index + 1} has invalid ${field}.`);
    }
  }

  private static requiredSha256(record: Record<string, unknown>, field: string, index: number): string {
    const value = this.requiredString(record, field, index).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Manifest row ${index + 1} has invalid ${field}.`);
    return value;
  }

  private static documentKindFor(value: string, index: number): FundReportDocument["document_kind"] {
    const allowed: Array<FundReportDocument["document_kind"]> = ["periodic_report", "report_notice", "business_notice", "sales_document", "other"];
    if (allowed.includes(value as FundReportDocument["document_kind"])) return value as FundReportDocument["document_kind"];
    throw new Error(`Manifest row ${index + 1} has invalid document_kind.`);
  }

  private static isValidIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp)) return false;
    return new Date(timestamp).toISOString().slice(0, 10) === value;
  }

  private static isFutureIsoDate(value: string): boolean {
    return value > nowIso().slice(0, 10);
  }
}
