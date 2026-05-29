import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface HkexAnnouncement {
  release_time: string;
  release_date: string;
  stock_code: string;
  stock_name: string;
  headline: string;
  document_title: string;
  document_url: string;
  document_type: "pdf" | "html" | "other";
}

interface HkexStockConfig {
  stockId: string;
  stockCode: string;
  stockName: string;
}

interface HkexStockSeed {
  query: string;
  stockId?: string;
  stockCode?: string;
  stockName?: string;
}

interface HkexStockInfo {
  stockId: string | number;
  code: string;
  name: string;
}

interface HkexStockSearchResponse {
  stockInfo?: HkexStockInfo[];
}

const HKEX_TITLE_SEARCH_PAGE = "https://www1.hkexnews.hk/search/titlesearch.xhtml";
const HKEX_STOCK_PREFIX_ENDPOINT = "https://www1.hkexnews.hk/search/prefix.do";

export class HkexOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly configuredSeeds: HkexStockSeed[] = HkexOfficialProvider.parseStockConfig(process.env.FUNDSENTINEL_HKEX_STOCK_IDS),
    private readonly maxStocks = Number(process.env.FUNDSENTINEL_HKEX_MAX_STOCKS ?? 4),
    private readonly maxAnnouncements = Number(process.env.FUNDSENTINEL_HKEX_MAX_ITEMS ?? 12)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "hkex-official",
      source_name: "HKEXnews Official Announcement Provider",
      source_type: "news",
      trust_level: "A",
      enabled: true,
      priority: 52,
      access_method: "official HKEXnews title search page: https://www1.hkexnews.hk/search/titlesearch.xhtml",
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
      freshness_policy: "HKEX issuer announcements are fresh within 14 days and acceptable within 45 days for market context",
      notes:
        "Fetches official HKEXnews listed-company announcement metadata for Hong Kong/QDII context. It records official links but does not parse document bodies, provide fund NAV, provide fund reports, or make investment advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    if (!input.required_data.some((item) => ["industry_news", "policy_evidence"].includes(item))) return false;
    if (this.configuredSeeds.length > 0) return true;
    if (HkexOfficialProvider.hasHongKongContext(input.context)) return true;
    return HkexOfficialProvider.hasCrossBorderContext(input.context) && HkexOfficialProvider.extractStockQueries(input.context).length > 0;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const warnings: string[] = [];
    const stocks = await this.resolveStockCandidates(input, warnings);
    if (!stocks.length) {
      return this.failure(
        info,
        "No HKEX stock candidates could be resolved from configured stock IDs or acquired HK holding context",
        [
          ...warnings,
          "HKEXnews provider 需要明确的港股持仓代码（例如 00700.HK）或 FUNDSENTINEL_HKEX_STOCK_IDS 配置；缺少候选证券时必须保留 industry_news/cross_border_fund_disclosure 缺口。"
        ],
        HKEX_STOCK_PREFIX_ENDPOINT
      );
    }

    const announcements = (await Promise.all(stocks.map(async (stock) => this.fetchStockAnnouncements(stock, warnings)))).flat();
    const deduped = HkexOfficialProvider.dedupeAnnouncements(announcements).slice(0, this.maxAnnouncements);

    if (!deduped.length) {
      return this.failure(
        info,
        warnings.join(" | ") || "No usable HKEX official announcements returned",
        [
          ...warnings,
          "HKEXnews 官方公告页面未返回可用公告；Argus 应保留 cross_border_fund_disclosure / industry_news 缺口并尝试 SEC EDGAR、交易所或人工官方来源。"
        ],
        HKEX_TITLE_SEARCH_PAGE
      );
    }

    const latestRelease = deduped.map((item) => item.release_time).sort().at(-1);
    const freshness = this.freshnessFor(latestRelease);
    const resultWarnings = [
      ...warnings,
      "HKEXnews 公告是香港上市公司/跨境市场背景，不代表单只基金投资建议或买卖结论。",
      "HKEXnews 公告元数据不可替代基金净值、持仓、基金定期报告或交易信号，也不会补齐 official_fund_reports。"
    ];
    if (freshness === "stale") resultWarnings.push("HKEXnews 最新公告偏旧，跨境市场背景证据应降级。");

    return {
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        news_summaries: deduped.map((announcement) => HkexOfficialProvider.summaryFor(announcement))
      },
      raw_reference: HKEX_TITLE_SEARCH_PAGE,
      fetched_at: nowIso(),
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseStockSearchResponse(text: string): HkexStockInfo[] {
    const trimmed = text.trim().replace(/^\uFEFF/u, "");
    const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.replace(/^[^(]*\(/u, "").replace(/\)\s*;?\s*$/u, "");
    const parsed = JSON.parse(jsonText) as HkexStockSearchResponse;
    return (parsed.stockInfo ?? []).filter((item) => item.stockId !== undefined && item.code && item.name);
  }

  static parseTitleSearchPage(html: string, pageUrl = HKEX_TITLE_SEARCH_PAGE): HkexAnnouncement[] {
    const rows: HkexAnnouncement[] = [];
    const rowPattern = /<tr\b[^>]*>[\s\S]*?<\/tr>/giu;
    for (const match of html.matchAll(rowPattern)) {
      const rowHtml = match[0] ?? "";
      if (!rowHtml.includes("release-time") || !rowHtml.includes("stock-short-code")) continue;
      const releaseTime = this.releaseTimeFor(rowHtml);
      const stockCode = this.textForClass(rowHtml, "stock-short-code").replace(/^Stock Code:\s*/iu, "");
      const stockName = this.textForClass(rowHtml, "stock-short-name").replace(/^Stock Short Name:\s*/iu, "");
      const headline = this.cleanText(this.firstMatch(rowHtml, /<div class="headline">([\s\S]*?)<\/div>/iu) ?? "");
      const link = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/iu.exec(rowHtml);
      const documentUrl = link?.[1] ? this.resolveUrl(link[1], pageUrl) : null;
      const documentTitle = this.cleanText(link?.[2] ?? "");
      if (!releaseTime || !stockCode || !stockName || !documentUrl || !documentTitle) continue;
      rows.push({
        release_time: releaseTime,
        release_date: releaseTime.slice(0, 10),
        stock_code: stockCode,
        stock_name: stockName,
        headline,
        document_title: documentTitle,
        document_url: documentUrl,
        document_type: this.documentTypeFor(documentUrl)
      });
    }
    return rows;
  }

  static extractStockQueries(context: ProviderFundPayload | undefined): string[] {
    const queries: string[] = [];
    for (const value of context?.portfolio_holdings ?? []) {
      const text = String(value);
      for (const pattern of [
        /\b(\d{4,5})\s*\.?\s*HK\b/giu,
        /\bHK[:\s-]*(\d{4,5})\b/giu,
        /港股[:\s-]*(\d{4,5})/giu,
        /H股[:\s-]*(\d{4,5})/giu
      ]) {
        for (const match of text.matchAll(pattern)) {
          if (match[1]) queries.push(this.normalizeStockCode(match[1]));
        }
      }
      if (/港股|香港|H股|HK\b|Hong Kong/iu.test(text)) {
        for (const match of text.matchAll(/\b(\d{4,5})\b/gu)) {
          if (match[1]) queries.push(this.normalizeStockCode(match[1]));
        }
      }
    }
    return [...new Set(queries)].slice(0, 12);
  }

  private async resolveStockCandidates(input: FundDataSourceInput, warnings: string[]): Promise<HkexStockConfig[]> {
    const contextSeeds: HkexStockSeed[] = HkexOfficialProvider.extractStockQueries(input.context).map((query) => ({ query }));
    const seeds: HkexStockSeed[] = [...this.configuredSeeds, ...contextSeeds].slice(0, Math.max(1, this.maxStocks * 2));
    const direct = seeds.flatMap((seed) =>
      seed.stockId && seed.stockCode
        ? [
            {
              stockId: seed.stockId,
              stockCode: HkexOfficialProvider.normalizeStockCode(seed.stockCode),
              stockName: seed.stockName ?? seed.stockCode
            }
          ]
        : []
    );
    const unresolved = seeds.filter((seed) => !seed.stockId || !seed.stockCode);
    const resolved = (await Promise.all(unresolved.map(async (seed) => this.resolveStockQuery(seed.query, warnings)))).filter((item) => item !== null);
    return HkexOfficialProvider.dedupeStocks([...direct, ...resolved]).slice(0, this.maxStocks);
  }

  private async resolveStockQuery(query: string, warnings: string[]): Promise<HkexStockConfig | null> {
    const normalizedQuery = HkexOfficialProvider.normalizeStockCode(query);
    const url = this.stockPrefixUrl(query);
    try {
      const response = await this.fetchWithTimeout(url);
      const text = await response.text();
      if (!response.ok) {
        warnings.push(`HKEXnews stock prefix 查询 ${query} 返回 HTTP ${response.status}。`);
        return null;
      }
      const rows = HkexOfficialProvider.parseStockSearchResponse(text);
      const exact = rows.find((row) => HkexOfficialProvider.normalizeStockCode(row.code) === normalizedQuery);
      const selected = exact ?? rows.find((row) => HkexOfficialProvider.isLikelyPrimaryListing(row)) ?? rows[0];
      if (!selected) {
        warnings.push(`HKEXnews stock prefix 查询 ${query} 未返回候选证券。`);
        return null;
      }
      return {
        stockId: String(selected.stockId),
        stockCode: HkexOfficialProvider.normalizeStockCode(selected.code),
        stockName: HkexOfficialProvider.cleanText(selected.name)
      };
    } catch (error) {
      warnings.push(`HKEXnews stock prefix 查询 ${query} 失败：${error instanceof Error ? error.message : String(error)}。`);
      return null;
    }
  }

  private async fetchStockAnnouncements(stock: HkexStockConfig, warnings: string[]): Promise<HkexAnnouncement[]> {
    const url = this.titleSearchUrl(stock);
    try {
      const response = await this.fetchWithTimeout(url);
      const text = await response.text();
      if (!response.ok) {
        warnings.push(`HKEXnews ${stock.stockCode} 页面返回 HTTP ${response.status}。`);
        return [];
      }
      const parsed = HkexOfficialProvider.parseTitleSearchPage(text, url).filter((item) => item.stock_code === stock.stockCode);
      if (!parsed.length) warnings.push(`HKEXnews ${stock.stockCode} 未返回可解析公告。`);
      return parsed.slice(0, 8);
    } catch (error) {
      warnings.push(`HKEXnews ${stock.stockCode} 抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return [];
    }
  }

  private titleSearchUrl(stock: HkexStockConfig): string {
    const params = new URLSearchParams({
      category: "0",
      market: "SEHK",
      stockId: stock.stockId,
      lang: "en"
    });
    return `${HKEX_TITLE_SEARCH_PAGE}?${params.toString()}`;
  }

  private stockPrefixUrl(query: string): string {
    const params = new URLSearchParams({
      lang: "EN",
      type: "A",
      name: query,
      market: "SEHK",
      callback: "callback"
    });
    return `${HKEX_STOCK_PREFIX_ENDPOINT}?${params.toString()}`;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal, headers: this.headers() });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      referer: `${HKEX_TITLE_SEARCH_PAGE}?lang=en`
    };
  }

  private freshnessFor(releaseTime?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!releaseTime) return "unknown";
    const match = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/u.exec(releaseTime);
    if (!match) return "unknown";
    const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 8, Number(match[5]));
    if (!Number.isFinite(timestamp)) return "unknown";
    const ageDays = Math.max(0, Date.now() - timestamp) / 86_400_000;
    if (ageDays <= 14) return "fresh";
    if (ageDays <= 45) return "acceptable";
    return "stale";
  }

  private failure(info: DataSourceInfo, error: string, warnings: string[], rawReference: string | null): DataProviderResult<ProviderFundPayload> {
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

  private static hasHongKongContext(context: ProviderFundPayload | undefined): boolean {
    const text = [
      context?.fund_name,
      context?.fund_type,
      ...(context?.themes ?? []),
      ...(context?.portfolio_holdings ?? []),
      ...(context?.news_summaries ?? [])
    ]
      .filter(Boolean)
      .join(" ");
    return /港股|香港|H股|恒生|互联互通|HK\b|Hong Kong/iu.test(text);
  }

  private static hasCrossBorderContext(context: ProviderFundPayload | undefined): boolean {
    const text = [
      context?.fund_name,
      context?.fund_type,
      ...(context?.themes ?? []),
      ...(context?.portfolio_holdings ?? []),
      ...(context?.news_summaries ?? [])
    ]
      .filter(Boolean)
      .join(" ");
    return /QDII|跨境|海外|全球/iu.test(text);
  }

  private static parseStockConfig(value: string | undefined): HkexStockSeed[] {
    if (!value?.trim()) return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [stockId, stockCode, ...nameParts] = item.split(":").map((part) => part.trim());
        if (stockId && stockCode && /^\d+$/u.test(stockId) && /^\d{1,5}$/u.test(stockCode)) {
          return { query: stockCode, stockId, stockCode: this.normalizeStockCode(stockCode), stockName: nameParts.join(":") || stockCode };
        }
        return { query: item };
      });
  }

  private static summaryFor(announcement: HkexAnnouncement): string {
    const title = announcement.headline ? `${announcement.headline}: ${announcement.document_title}` : announcement.document_title;
    return `HKEXnews 官方公告：${announcement.release_time} ${announcement.stock_code} ${announcement.stock_name} ${title} ${announcement.document_url}`;
  }

  private static dedupeAnnouncements(announcements: HkexAnnouncement[]): HkexAnnouncement[] {
    const seen = new Set<string>();
    return announcements
      .sort((left, right) => right.release_time.localeCompare(left.release_time))
      .filter((announcement) => {
        const key = `${announcement.stock_code}|${announcement.release_time}|${announcement.document_url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  private static dedupeStocks(stocks: HkexStockConfig[]): HkexStockConfig[] {
    const seen = new Set<string>();
    return stocks.filter((stock) => {
      const key = `${stock.stockId}|${stock.stockCode}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private static isLikelyPrimaryListing(row: HkexStockInfo): boolean {
    const name = this.cleanText(row.name).toUpperCase();
    return !/[.@]|\b[NBCPW]\d{4,}\b|CALL|PUT|-R\b/u.test(name);
  }

  private static textForClass(html: string, className: string): string {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`<td[^>]*class=["'][^"']*${escaped}[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "iu").exec(html);
    return this.cleanText(match?.[1] ?? "");
  }

  private static releaseTimeFor(html: string): string {
    const text = this.textForClass(html, "release-time").replace(/^Release Time:\s*/iu, "");
    const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/u.exec(text);
    return match ? `${match[3]}-${match[2]}-${match[1]} ${match[4]}:${match[5]}` : "";
  }

  private static firstMatch(text: string, pattern: RegExp): string | null {
    return pattern.exec(text)?.[1] ?? null;
  }

  private static cleanText(value: string): string {
    return value
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
      .replace(/&#x27;/gu, "'")
      .replace(/&quot;/gu, '"')
      .replace(/&amp;/gu, "&")
      .replace(/&nbsp;/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static normalizeStockCode(value: string): string {
    const digits = value.replace(/[^\d]/gu, "");
    if (!digits) return value.trim().toUpperCase();
    return digits.length <= 5 ? digits.padStart(5, "0") : digits;
  }

  private static documentTypeFor(url: string): HkexAnnouncement["document_type"] {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".pdf")) return "pdf";
    if (pathname.endsWith(".htm") || pathname.endsWith(".html")) return "html";
    return "other";
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
