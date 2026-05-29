import { nowIso } from "../../schemas/index.js";
import type { FundReportDocument } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface SecTickerRow {
  cik: number;
  name: string;
  ticker: string;
  exchange: string;
}

interface SecSubmissionsPayload {
  cik?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      reportDate?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

interface SecFiling {
  accessionNumber: string;
  filingDate: string | null;
  reportDate: string | null;
  form: string;
  primaryDocument: string | null;
  primaryDocDescription: string | null;
}

const SEC_TICKER_EXCHANGE_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const SEC_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions";
const SEC_ARCHIVES_BASE_URL = "https://www.sec.gov/Archives/edgar/data";
const RELEVANT_FORMS = new Set(["NPORT-P", "N-CEN", "N-CSR", "N-CSRS", "N-1A", "485BPOS", "497", "24F-2NT", "N-30D"]);

export class SecEdgarProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly tickerExchangeUrl = SEC_TICKER_EXCHANGE_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "sec-edgar",
      source_name: "SEC EDGAR Official Fund Disclosure Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      enabled: true,
      priority: 51,
      access_method: "official SEC ticker index and submissions JSON API: https://www.sec.gov/files/company_tickers_exchange.json and https://data.sec.gov/submissions/CIK{cik}.json",
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
      freshness_policy: "SEC fund filings should be fresh within 150 days and acceptable within 365 days for QDII/global ETF context",
      notes:
        "Fetches SEC EDGAR official submissions metadata for US tickers/CIKs and records recent fund disclosure filings. It does not parse filing body text, provide NAV, or make advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    if (!input.required_data.some((item) => ["fund_reports", "industry_news", "policy_evidence"].includes(item))) return false;
    return SecEdgarProvider.inputLooksLikeSecIdentifier(input.fund_code);
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const identifier = input.fund_code.trim().toUpperCase();
    if (!SecEdgarProvider.inputLooksLikeSecIdentifier(identifier)) {
      return this.failure(info, `Unsupported SEC identifier: ${input.fund_code}`, ["SEC EDGAR provider 仅处理 US ticker 或 CIK，不处理中国 6 位基金代码。"]);
    }

    try {
      const company = await this.resolveCompany(identifier);
      if (!company) {
        return this.failure(info, `No SEC ticker/CIK match for ${identifier}`, ["SEC 官方 ticker/CIK 索引未找到该标识，Argus 应保留跨境官方披露缺口。"], this.tickerExchangeUrl);
      }

      const submissionsUrl = SecEdgarProvider.submissionsUrl(company.cik);
      const response = await this.fetchWithTimeout(submissionsUrl, "https://www.sec.gov/");
      if (!response.ok) {
        return this.failure(info, `SEC submissions HTTP ${response.status}`, [`SEC submissions API 返回 HTTP ${response.status}。`], submissionsUrl);
      }

      const payload = SecEdgarProvider.parseSubmissions(await response.text());
      const filings = SecEdgarProvider.relevantFundFilings(payload).slice(0, 8);
      if (!filings.length) {
        return this.failure(info, "No recent SEC fund disclosure filings found", ["SEC submissions API 可访问，但未识别到 NPORT-P、N-CEN、N-CSR、N-1A、497 等基金相关披露。"], submissionsUrl);
      }

      const documents = filings.map((filing) => SecEdgarProvider.documentFor(filing, company.cik, payload.name ?? company.name));
      const latestDate = filings.map((filing) => filing.filingDate).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "SEC EDGAR 是美国官方披露来源；当前 provider 只记录 filings 元数据和官方 URL，不解析正文、不生成基金净值或持仓结论。",
        "SEC EDGAR 跨境披露上下文不可替代国内基金净值、持仓、定期报告正文或交易信号。"
      ];
      if (freshness === "stale") warnings.push("SEC EDGAR 最新基金披露日期偏旧，QDII/海外 ETF 相关结论必须降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: identifier,
          fund_name: payload.name ?? company.name,
          fund_type: "us_sec_registered_fund_or_etf",
          fund_report_refs: documents.map((document) => this.reportRefFor(document)),
          fund_report_documents: documents,
          news_summaries: filings.map((filing) => `SEC EDGAR 官方披露：${payload.name ?? company.name} ${filing.form} filed ${filing.filingDate ?? "unknown-date"}`)
        },
        raw_reference: submissionsUrl,
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
        ["SEC EDGAR 官方 API 抓取失败，Argus 应保留跨境官方披露缺口并尝试 SEC 手动 URL 导入或其他官方披露源。"],
        this.tickerExchangeUrl
      );
    }
  }

  static inputLooksLikeSecIdentifier(value: string): boolean {
    const normalized = value.trim().toUpperCase();
    if (/^CIK\d{1,10}$/u.test(normalized)) return true;
    if (/^\d{1,10}$/u.test(normalized) && !/^\d{6}$/u.test(normalized)) return true;
    return /^[A-Z][A-Z0-9.-]{0,9}$/u.test(normalized);
  }

  static parseTickerExchange(text: string): SecTickerRow[] {
    const parsed = JSON.parse(text) as { fields?: string[]; data?: unknown[][] };
    const fields = parsed.fields ?? [];
    const rows = parsed.data ?? [];
    const cikIndex = fields.indexOf("cik");
    const nameIndex = fields.indexOf("name");
    const tickerIndex = fields.indexOf("ticker");
    const exchangeIndex = fields.indexOf("exchange");
    if ([cikIndex, nameIndex, tickerIndex, exchangeIndex].some((index) => index < 0)) return [];
    return rows
      .map((row) => ({
        cik: Number(row[cikIndex]),
        name: String(row[nameIndex] ?? ""),
        ticker: String(row[tickerIndex] ?? "").toUpperCase(),
        exchange: String(row[exchangeIndex] ?? "")
      }))
      .filter((row) => Number.isFinite(row.cik) && row.name && row.ticker);
  }

  static parseSubmissions(text: string): SecSubmissionsPayload {
    return JSON.parse(text) as SecSubmissionsPayload;
  }

  static relevantFundFilings(payload: SecSubmissionsPayload): SecFiling[] {
    const recent = payload.filings?.recent;
    const forms = recent?.form ?? [];
    return forms
      .map((form, index) => ({
        accessionNumber: recent?.accessionNumber?.[index] ?? "",
        filingDate: recent?.filingDate?.[index] ?? null,
        reportDate: recent?.reportDate?.[index] ?? null,
        form,
        primaryDocument: recent?.primaryDocument?.[index] ?? null,
        primaryDocDescription: recent?.primaryDocDescription?.[index] ?? null
      }))
      .filter((filing) => filing.accessionNumber && RELEVANT_FORMS.has(filing.form))
      .sort((left, right) => (right.filingDate ?? "").localeCompare(left.filingDate ?? ""));
  }

  private async resolveCompany(identifier: string): Promise<{ cik: string; name: string; ticker: string | null; exchange: string | null } | null> {
    if (/^CIK?\d{1,10}$/u.test(identifier)) {
      const digits = identifier.replace(/^CIK/u, "");
      return { cik: digits.padStart(10, "0"), name: `CIK ${digits.padStart(10, "0")}`, ticker: null, exchange: null };
    }

    const response = await this.fetchWithTimeout(this.tickerExchangeUrl, "https://www.sec.gov/");
    if (!response.ok) throw new Error(`SEC ticker index HTTP ${response.status}`);
    const ticker = identifier.toUpperCase();
    const row = SecEdgarProvider.parseTickerExchange(await response.text()).find((item) => item.ticker === ticker);
    return row
      ? {
          cik: String(row.cik).padStart(10, "0"),
          name: row.name,
          ticker: row.ticker,
          exchange: row.exchange
        }
      : null;
  }

  private async fetchWithTimeout(url: string, referer: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal, headers: this.headers(referer) });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(referer: string): HeadersInit {
    return {
      "user-agent": process.env.FUNDSENTINEL_SEC_USER_AGENT ?? "FundSentinel/0.1 contact@example.com",
      accept: "application/json,text/plain,*/*",
      referer
    };
  }

  private freshnessFor(date?: string | null): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 150) return "fresh";
    if (ageDays <= 365) return "acceptable";
    return "stale";
  }

  private reportRefFor(document: FundReportDocument): string {
    return `${document.published_at ?? "unknown-date"} ${document.title} id=${document.announcement_id} kind=${document.document_kind} url=${document.detail_url ?? ""}`;
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

  private static submissionsUrl(cik: string): string {
    return `${SEC_SUBMISSIONS_BASE_URL}/CIK${cik.padStart(10, "0")}.json`;
  }

  private static documentFor(filing: SecFiling, cik: string, companyName: string): FundReportDocument {
    const normalizedAccession = filing.accessionNumber.replace(/-/gu, "");
    const primaryDocument = filing.primaryDocument ?? "";
    const detailUrl = `${SEC_ARCHIVES_BASE_URL}/${Number(cik)}/${normalizedAccession}/${filing.accessionNumber}-index.html`;
    const filingUrl = primaryDocument ? `${SEC_ARCHIVES_BASE_URL}/${Number(cik)}/${normalizedAccession}/${primaryDocument}` : detailUrl;
    return {
      title: `${companyName} ${filing.form}${filing.primaryDocDescription ? ` ${filing.primaryDocDescription}` : ""}`,
      announcement_id: `sec-${filing.accessionNumber}`,
      published_at: filing.filingDate,
      category: filing.form,
      document_kind: this.documentKindFor(filing.form),
      detail_url: detailUrl,
      pdf_url: filingUrl,
      pdf_verified: false,
      pdf_content_type: null,
      pdf_content_length: null,
      source_name: "SEC EDGAR",
      source_type: "official_disclosure",
      trust_level: "A"
    };
  }

  private static documentKindFor(form: string): FundReportDocument["document_kind"] {
    if (["NPORT-P", "N-CEN", "N-CSR", "N-CSRS", "N-30D"].includes(form)) return "periodic_report";
    if (["N-1A", "485BPOS", "497"].includes(form)) return "sales_document";
    return "other";
  }
}
