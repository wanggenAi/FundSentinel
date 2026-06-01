import type { ProviderFundPayload } from "./sourceTypes.js";

type FundReportDocumentPayload = NonNullable<ProviderFundPayload["fund_report_documents"]>[number];

const FUND_REPORT_DOCUMENT_KINDS = new Set<FundReportDocumentPayload["document_kind"]>([
  "periodic_report",
  "report_notice",
  "business_notice",
  "sales_document",
  "other"
]);
const FUND_REPORT_SOURCE_TYPES = new Set<FundReportDocumentPayload["source_type"]>(["aggregator_index", "official_disclosure", "manual_import"]);
const FUND_REPORT_TRUST_LEVELS = new Set<FundReportDocumentPayload["trust_level"]>(["A", "B", "C", "D", "E", "DEMO"]);

export function validFundReportDocuments(documents: unknown): ProviderFundPayload["fund_report_documents"] | undefined {
  if (!Array.isArray(documents)) return undefined;
  const valid = documents.flatMap((document) => {
    const normalized = normalizedFundReportDocument(document);
    return normalized ? [normalized] : [];
  });
  return valid.length ? valid : undefined;
}

export function isValidFundReportDocument(document: unknown): document is FundReportDocumentPayload {
  return Boolean(normalizedFundReportDocument(document));
}

function normalizedFundReportDocument(document: unknown): FundReportDocumentPayload | null {
  if (!isRecord(document)) return null;
  if (!hasNonEmptyString(document.title)) return null;
  if (!hasNonEmptyString(document.announcement_id)) return null;
  if (!isNullableNonEmptyString(document.published_at)) return null;
  if (!isStringOrNull(document.category)) return null;
  if (!FUND_REPORT_DOCUMENT_KINDS.has(document.document_kind as FundReportDocumentPayload["document_kind"])) return null;
  if (!isNullableNonEmptyString(document.detail_url)) return null;
  if (!isNullableNonEmptyString(document.pdf_url)) return null;
  if (typeof document.pdf_verified !== "boolean") return null;
  if (!isNullableNonEmptyString(document.pdf_content_type)) return null;
  if (!isNullableNonNegativeNumber(document.pdf_content_length)) return null;
  if (!isOptionalStringOrNull(document.pdf_sha256)) return null;
  if (!hasNonEmptyString(document.source_name)) return null;
  if (!FUND_REPORT_SOURCE_TYPES.has(document.source_type as FundReportDocumentPayload["source_type"])) return null;
  if (!FUND_REPORT_TRUST_LEVELS.has(document.trust_level as FundReportDocumentPayload["trust_level"])) return null;

  const verifiedPdfMetadata =
    hasNonEmptyString(document.pdf_url) &&
    hasNonEmptyString(document.pdf_content_type) &&
    document.pdf_content_type.toLowerCase().includes("pdf") &&
    isPositiveFiniteNumber(document.pdf_content_length);

  return {
    title: document.title,
    announcement_id: document.announcement_id,
    published_at: document.published_at,
    category: document.category,
    document_kind: document.document_kind as FundReportDocumentPayload["document_kind"],
    detail_url: document.detail_url,
    pdf_url: document.pdf_url,
    pdf_verified: document.pdf_verified && verifiedPdfMetadata,
    pdf_content_type: document.pdf_content_type,
    pdf_content_length: document.pdf_content_length,
    pdf_sha256: document.pdf_sha256,
    source_name: document.source_name,
    source_type: document.source_type as FundReportDocumentPayload["source_type"],
    trust_level: document.trust_level as FundReportDocumentPayload["trust_level"]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || hasNonEmptyString(value);
}

function isOptionalStringOrNull(value: unknown): value is string | null | undefined {
  return value === undefined || typeof value === "string" || value === null;
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
