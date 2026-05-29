import { inflateRawSync } from "node:zlib";
import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface CsrcPublicFundProduct {
  sequence: number | null;
  fund_code: string;
  fund_name: string;
  established_at: string | null;
}

interface XlsxCell {
  ref: string;
  type: string | null;
  value: string;
}

const CSRC_PRODUCT_INDEX_PAGE = "https://www.csrc.gov.cn/csrc/c101900/c1029655/content.shtml";

export class CsrcPublicFundProductProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly indexPageUrl = CSRC_PRODUCT_INDEX_PAGE
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "csrc-public-fund-products",
      source_name: "China Securities Regulatory Commission Public Fund Product Index Provider",
      source_type: "fund_meta",
      trust_level: "A",
      enabled: true,
      priority: 3,
      access_method: `official CSRC public fund product index XLSX: ${this.indexPageUrl}`,
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
      freshness_policy: "official public fund product index should be refreshed within 210 days and acceptable within 420 days",
      notes:
        "Fetches the official CSRC public fund product index attachment and parses fund code/name/establishment date. It provides fund metadata only; NAV, holdings, and reports remain separate requirements."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("fund_meta");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/u.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"], this.indexPageUrl);
    }

    try {
      const pageResponse = await this.fetchWithTimeout(this.indexPageUrl);
      const pageText = await pageResponse.text();
      if (!pageResponse.ok) {
        return this.failure(info, `HTTP ${pageResponse.status}`, [`中国证监会公募基金产品索引页面返回 HTTP ${pageResponse.status}。`], this.indexPageUrl);
      }

      const attachment = CsrcPublicFundProductProvider.parseAttachmentLink(pageText, this.indexPageUrl);
      if (!attachment) {
        return this.failure(info, "No official CSRC public fund product XLSX attachment found", ["中国证监会公募基金产品索引页面未解析到 XLSX 附件。"], this.indexPageUrl);
      }

      const xlsxResponse = await this.fetchWithTimeout(attachment.url);
      if (!xlsxResponse.ok) {
        return this.failure(info, `XLSX HTTP ${xlsxResponse.status}`, [`中国证监会公募基金产品索引 XLSX 返回 HTTP ${xlsxResponse.status}。`], attachment.url);
      }
      const buffer = Buffer.from(await xlsxResponse.arrayBuffer());
      if (!CsrcPublicFundProductProvider.looksLikeXlsx(buffer)) {
        return this.failure(info, "Official CSRC product index attachment is not a valid XLSX zip", ["中国证监会公募基金产品索引附件不是可识别的 XLSX/ZIP 文件。"], attachment.url);
      }

      const entries = await CsrcPublicFundProductProvider.parseXlsxProducts(buffer);
      const product = entries.find((item) => item.fund_code === input.fund_code);
      if (!product) {
        return this.failure(
          info,
          `Fund code ${input.fund_code} not found in official CSRC public fund product index`,
          ["中国证监会公募基金产品索引未找到该基金代码，Argus 应保留 fund_meta 缺口并尝试基金公司官网、巨潮或人工导入。"],
          attachment.url
        );
      }

      const asOf = CsrcPublicFundProductProvider.asOfDateFrom(`${attachment.title} ${pageText}`) ?? product.established_at;
      const freshness = this.freshnessFor(asOf);
      const warnings = [
        "中国证监会公募基金产品索引仅提供官方基金元数据，不能补齐净值、持仓或定期报告证据。",
        "该 provider 的覆盖范围应在 DataGapReport 中保持可审计。"
      ];
      if (freshness === "stale") warnings.push("中国证监会公募基金产品索引日期偏旧，基金元数据应降级并交叉验证。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: product.fund_code,
          fund_name: product.fund_name,
          fund_type: CsrcPublicFundProductProvider.inferFundType(product.fund_name),
          themes: CsrcPublicFundProductProvider.inferThemes(product.fund_name)
        },
        raw_reference: attachment.url,
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
        ["中国证监会公募基金产品索引抓取或解析失败，Argus 应保留 fund_meta 缺口并尝试基金公司官网、巨潮或人工导入。"],
        this.indexPageUrl
      );
    }
  }

  static parseAttachmentLink(html: string, pageUrl = CSRC_PRODUCT_INDEX_PAGE): { title: string; url: string } | null {
    const anchors = [...html.matchAll(/<a\s+([^>]*)>([\s\S]*?)<\/a>/giu)];
    for (const anchor of anchors) {
      const attrs = anchor[1] ?? "";
      const label = this.cleanText(anchor[2] ?? "");
      const href = this.attributeValue(attrs, "href");
      if (!href || !/公募基金产品索引|\.xlsx/iu.test(`${label} ${href}`)) continue;
      return {
        title: label || href.split("/").at(-1) || "公募基金产品索引",
        url: this.resolveUrl(href, pageUrl)
      };
    }
    return null;
  }

  static async parseXlsxProducts(buffer: Buffer): Promise<CsrcPublicFundProduct[]> {
    const [sharedStringsXml, sheetXml] = await Promise.all([
      this.readZipEntry(buffer, "xl/sharedStrings.xml"),
      this.readZipEntry(buffer, "xl/worksheets/sheet1.xml")
    ]);
    return this.parseWorksheetProducts(sheetXml, this.parseSharedStrings(sharedStringsXml));
  }

  static parseWorksheetProducts(sheetXml: string, sharedStrings: string[]): CsrcPublicFundProduct[] {
    const rows = [...sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/giu)].map((match) => this.rowValues(match[1] ?? "", sharedStrings));
    const headerIndex = rows.findIndex((row) => row.includes("基金代码") && row.includes("基金简称"));
    if (headerIndex < 0) return [];
    return rows
      .slice(headerIndex + 1)
      .map((row) => this.productFromRow(row))
      .filter((item) => item !== null);
  }

  static parseSharedStrings(xml: string): string[] {
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)].map((match) =>
      [...(match[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)].map((textMatch) => this.decodeXml(textMatch[1] ?? "")).join("")
    );
  }

  static excelSerialDateToIso(value: string): string | null {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial <= 0) return null;
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
  }

  static asOfDateFrom(text: string): string | null {
    const compact = text.replace(/\s+/gu, "");
    const match = /截至(\d{4})(\d{2})(\d{2})/u.exec(compact);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  static looksLikeXlsx(buffer: Buffer): boolean {
    return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  }

  private static productFromRow(row: string[]): CsrcPublicFundProduct | null {
    const fundCode = row[1]?.padStart(6, "0");
    const fundName = row[2];
    if (!fundCode || !/^\d{6}$/u.test(fundCode) || !fundName) return null;
    return {
      sequence: row[0] && Number.isFinite(Number(row[0])) ? Number(row[0]) : null,
      fund_code: fundCode,
      fund_name: fundName,
      established_at: this.excelSerialDateToIso(row[3] ?? "")
    };
  }

  private static rowValues(rowXml: string, sharedStrings: string[]): string[] {
    const values: string[] = [];
    for (const cell of this.cellsFrom(rowXml)) {
      const columnIndex = this.columnIndexFrom(cell.ref);
      if (columnIndex < 0) continue;
      values[columnIndex] = cell.type === "s" ? sharedStrings[Number(cell.value)] ?? "" : this.decodeXml(cell.value);
    }
    return values.map((value) => this.cleanText(value ?? ""));
  }

  private static cellsFrom(rowXml: string): XlsxCell[] {
    return [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/giu)].map((match) => ({
      ref: this.attributeValue(match[1] ?? "", "r") ?? "",
      type: this.attributeValue(match[1] ?? "", "t"),
      value: /<v\b[^>]*>([\s\S]*?)<\/v>/iu.exec(match[2] ?? "")?.[1] ?? ""
    }));
  }

  private static columnIndexFrom(ref: string): number {
    const letters = /^[A-Z]+/iu.exec(ref)?.[0]?.toUpperCase();
    if (!letters) return -1;
    return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
  }

  private static async readZipEntry(buffer: Buffer, entryName: string): Promise<string> {
    const eocdOffset = this.findEndOfCentralDirectory(buffer);
    const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
    const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

    let offset = centralDirectoryOffset;
    while (offset < centralDirectoryEnd) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const compressionMethod = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const fileNameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localHeaderOffset = buffer.readUInt32LE(offset + 42);
      const nameStart = offset + 46;
      const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
      if (name === entryName) {
        return this.readZipEntryFromLocalHeader(buffer, localHeaderOffset, compressedSize, compressionMethod, entryName);
      }
      offset = nameStart + fileNameLength + extraLength + commentLength;
    }

    throw new Error(`XLSX entry ${entryName} not found`);
  }

  private static readZipEntryFromLocalHeader(
    buffer: Buffer,
    localHeaderOffset: number,
    compressedSize: number,
    compressionMethod: number,
    entryName: string
  ): string {
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`XLSX entry ${entryName} local header is invalid`);
    const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    if (compressionMethod === 0) return compressed.toString("utf8");
    if (compressionMethod === 8) return inflateRawSync(compressed).toString("utf8");
    throw new Error(`XLSX entry ${entryName} uses unsupported compression method ${compressionMethod}`);
  }

  private static findEndOfCentralDirectory(buffer: Buffer): number {
    const minimumOffset = Math.max(0, buffer.length - 65_557);
    for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
    }
    throw new Error("XLSX ZIP central directory not found");
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal, headers: this.headers(url) });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(url: string): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: url.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*" : "text/html,application/xhtml+xml,*/*",
      referer: this.indexPageUrl
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

  private freshnessFor(date?: string | null): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 210) return "fresh";
    if (ageDays <= 420) return "acceptable";
    return "stale";
  }

  private static inferFundType(name: string): string {
    if (name.includes("QDII")) return "qdii";
    if (name.includes("债")) return "bond";
    if (name.includes("指数") || name.includes("ETF")) return "index";
    if (name.includes("货币")) return "money_market";
    if (name.includes("混合")) return "mixed";
    if (name.includes("股票")) return "equity";
    if (name.includes("FOF")) return "fof";
    return "unknown";
  }

  private static inferThemes(name: string): string[] {
    const themes: string[] = [];
    for (const keyword of ["信用", "科技", "医药", "消费", "新能源", "红利", "港股", "海外", "黄金", "半导体", "机器人"]) {
      if (name.includes(keyword)) themes.push(keyword);
    }
    if (name.includes("QDII")) themes.push("跨境");
    return [...new Set(themes)];
  }

  private static attributeValue(attrs: string, name: string): string | null {
    const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(attrs);
    return match ? this.decodeXml(match[1] ?? "") : null;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }

  private static cleanText(value: string): string {
    return this.decodeXml(value.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
  }

  private static decodeXml(value: string): string {
    return value
      .replace(/&ensp;|&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'");
  }
}
