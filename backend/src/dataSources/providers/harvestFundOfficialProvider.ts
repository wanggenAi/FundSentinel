import { TextDecoder } from "node:util";
import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface HarvestFundDetail {
  fundName?: string;
  fundType?: string;
  productId?: string;
}

interface HarvestFundListRow {
  fundName: string;
  date?: string;
  currentNav?: number;
  accumulatedNav?: number;
  dailyReturn?: number;
  stageReturns: Record<string, number>;
  detailUrl: string | null;
  historyUrl: string | null;
}

interface HarvestFundNavRow {
  date: string;
  nav: number;
  accumulatedNav?: number;
}

export class HarvestFundOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://www.jsfund.cn";
  private static readonly productListUrl = `${HarvestFundOfficialProvider.baseUrl}/Services/cn/jsp/product/DetailList.jsp`;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 12000),
    private readonly maxNavRows = Number(process.env.FUNDSENTINEL_HARVEST_NAV_ROW_COUNT ?? 260)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "harvestfund-official",
      source_name: "嘉实基金官网官方净值 Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 7,
      access_method:
        "official fund company website: https://www.jsfund.cn/main/fund/{fund_code}/fundManager.shtml plus /Services/cn/jsp/product/DetailList.jsp and NavHistory.jsp",
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
      freshness_policy: "official company NAV rows should be fresh within 10 days and acceptable within 30 days",
      notes:
        "Parses Harvest Fund official product pages, the official current NAV list, and the official NAV history table. It does not parse holdings, report PDF bodies, account, or transaction features."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/u.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const detailUrl = this.fundDetailUrl(input.fund_code);
    const listUrl = HarvestFundOfficialProvider.productListUrl;
    const historyUrl = this.navHistoryUrl(input.fund_code);
    const warnings = [
      "嘉实基金官网是基金公司官方来源；当前 provider 仅解析官网产品页、当前净值列表和历史净值表，不解析持仓、PDF 正文或交易功能。",
      "嘉实基金官网页面可能包含登录或申赎入口；Argus 只读取公开披露数据，不接入交易、账户或支付功能。"
    ];

    try {
      const [detailHtml, listHtml, historyHtml] = await Promise.all([
        this.fetchOptionalText(detailUrl, warnings, "嘉实基金官网产品详情页"),
        this.fetchOptionalText(listUrl, warnings, "嘉实基金官网当前净值列表"),
        this.fetchOptionalText(historyUrl, warnings, "嘉实基金官网历史净值表", detailUrl)
      ]);

      const detail =
        detailHtml && !HarvestFundOfficialProvider.isUnavailablePage(detailHtml)
          ? HarvestFundOfficialProvider.parseFundDetailPage(detailHtml, input.fund_code)
          : {};
      const listRow = listHtml ? HarvestFundOfficialProvider.parseDetailList(listHtml, input.fund_code, listUrl) : null;
      const allNavRows = historyHtml ? HarvestFundOfficialProvider.parseNavHistoryPage(historyHtml, input.fund_code) : [];
      const navRows = this.maxNavRows > 0 ? allNavRows.slice(-this.maxNavRows) : allNavRows;
      const historyFundName = historyHtml ? HarvestFundOfficialProvider.parseHistoryFundName(historyHtml, input.fund_code) : undefined;

      if (detailHtml && (!detail.fundName || HarvestFundOfficialProvider.isUnavailablePage(detailHtml))) {
        warnings.push("嘉实基金官网产品详情页未返回可验证的基金简称，已使用官网净值列表或历史净值表交叉补充。");
      }
      if (!listRow) warnings.push("嘉实基金官网当前净值列表未找到该基金代码对应行。");
      if (!navRows.length) warnings.push("嘉实基金官网历史净值表未返回可用净值行。");

      if (!detail.fundName && !listRow && !navRows.length) {
        return this.failure(
          info,
          "Fund not found on Harvest Fund official website",
          [...warnings, "嘉实基金官网未返回可验证的基金详情、当前净值或历史净值。"],
          detailUrl
        );
      }

      const latestHistory = navRows.at(-1);
      if (
        listRow?.date &&
        latestHistory?.date === listRow.date &&
        listRow.currentNav !== undefined &&
        Math.abs(listRow.currentNav - latestHistory.nav) > 0.0005
      ) {
        warnings.push("嘉实基金官网当日净值列表与历史净值表存在差异，强结论应等待官方确认或交叉校验。");
      }

      const currentNav = listRow?.currentNav ?? latestHistory?.nav;
      const currentNavDate = listRow?.date ?? latestHistory?.date;
      const freshness = this.freshnessFor(currentNavDate);
      if (freshness === "stale") warnings.push("嘉实基金官网最新净值日期偏旧，强结论应降级。");
      warnings.push("嘉实基金官网 provider 暂不提供官方定期报告正文或 PDF 元数据，official_fund_reports 仍需证监会、巨潮、基金公司公告 PDF 或人工官方导入。");

      const stageReturns = listRow?.stageReturns;
      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: currentNav !== undefined && navRows.length ? "partial" : "insufficient",
        success: currentNav !== undefined || navRows.length > 0 || Boolean(detail.fundName ?? listRow?.fundName),
        data: {
          fund_code: input.fund_code,
          fund_name: detail.fundName ?? listRow?.fundName ?? historyFundName,
          fund_type: detail.fundType,
          current_nav: currentNav,
          daily_return: listRow?.dailyReturn,
          nav_history: navRows.map((row) => row.nav),
          nav_history_dates: navRows.map((row) => row.date),
          stage_returns: stageReturns && Object.keys(stageReturns).length ? stageReturns : undefined
        },
        raw_reference: detail.fundName ? detailUrl : listRow?.detailUrl ?? historyUrl,
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
        ["嘉实基金官网官方数据抓取失败，应保留官方 current_nav/nav_history/fund_meta 缺口并尝试其他基金公司、证监会或授权 API。"],
        detailUrl
      );
    }
  }

  static parseFundDetailPage(html: string, fundCode: string): HarvestFundDetail {
    if (!html.includes(fundCode)) return {};
    const titleBlock = this.firstMatchRaw(html, /<h2[^>]+id=["']product_title["'][^>]*>([\s\S]*?)<\/h2>/iu);
    const titleText = titleBlock ? this.stripHtml(titleBlock).replace(new RegExp(`${fundCode}\\s*$`, "u"), "").trim() : undefined;
    const titleFallback = this.firstMatch(html, new RegExp(`【官网】([^<(（_]+)[(（]${fundCode}[)）]`, "u"));
    return {
      fundName: titleText || titleFallback,
      fundType: this.firstMatch(html, /<span[^>]+id=["']product_type["'][^>]*>([\s\S]*?)<\/span>/iu),
      productId:
        this.firstMatch(html, /<input[^>]+id=["']product_id["'][^>]+value=["']([^"']+)["'][^>]*>/iu) ??
        this.firstMatch(html, /<input[^>]+value=["']([^"']+)["'][^>]+id=["']product_id["'][^>]*>/iu)
    };
  }

  static parseDetailList(html: string, fundCode: string, pageUrl = HarvestFundOfficialProvider.productListUrl): HarvestFundListRow | null {
    const rows = html.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? [];
    const fundCodePattern = new RegExp(`(?:fundcode|FundCode)=${fundCode}(?:\\b|["'&])`, "u");
    for (const rowHtml of rows) {
      if (!fundCodePattern.test(rowHtml) && !rowHtml.includes(fundCode)) continue;
      const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)].map((match) => this.stripHtml(match[1] ?? ""));
      if (cells.length < 4) continue;
      const hrefs = [...rowHtml.matchAll(/href=["']([^"']+)["']/giu)].map((match) => match[1] ?? "");
      const detailHref = hrefs.find((href) => new RegExp(`fundcode=${fundCode}\\b`, "u").test(href));
      const historyHref = hrefs.find((href) => /NavHistory\.jsp/iu.test(href));
      const stageReturns = {
        ...this.stageReturn("ytd", cells[5]),
        ...this.stageReturn("1m", cells[6]),
        ...this.stageReturn("3m", cells[7]),
        ...this.stageReturn("3y", cells[8])
      };
      return {
        fundName: cells[0],
        date: this.dateOrUndefined(cells[1]),
        currentNav: this.numberOrUndefined(cells[2]),
        accumulatedNav: this.numberOrUndefined(cells[3]),
        dailyReturn: this.numberOrUndefined(cells[4]),
        stageReturns,
        detailUrl: detailHref ? this.resolveUrl(detailHref, pageUrl) : null,
        historyUrl: historyHref ? this.resolveUrl(historyHref, pageUrl) : null
      };
    }
    return null;
  }

  static parseNavHistoryPage(html: string, fundCode: string): HarvestFundNavRow[] {
    if (!html.includes(fundCode)) return [];
    const rows = new Map<string, HarvestFundNavRow>();
    const rowPattern =
      /<tr\b[^>]*>\s*<td\b[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>\s*<td\b[^>]*>\s*([\d.,-]+)\s*<\/td>\s*<td\b[^>]*>\s*([\d.,-]+)\s*<\/td>[\s\S]*?<\/tr>/giu;
    for (const match of html.matchAll(rowPattern)) {
      const date = match[1];
      const nav = this.numberOrUndefined(match[2]);
      if (!date || nav === undefined) continue;
      rows.set(date, {
        date,
        nav,
        accumulatedNav: this.numberOrUndefined(match[3])
      });
    }
    return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  static parseHistoryFundName(html: string, fundCode: string): string | undefined {
    for (const match of html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/giu)) {
      const attrs = match[1] ?? "";
      if (!new RegExp(`value=["']${fundCode}["']`, "u").test(attrs)) continue;
      return this.stripHtml(match[2] ?? "");
    }
    return undefined;
  }

  private async fetchOptionalText(url: string, warnings: string[], label: string, referer?: string): Promise<string | null> {
    try {
      const response = await this.fetchWithTimeout(url, { headers: this.headers(referer) }, this.timeoutMs);
      if (!response.ok) {
        warnings.push(`${label}返回 HTTP ${response.status}。`);
        return null;
      }
      return await this.decodeResponse(response, "utf-8");
    } catch (error) {
      warnings.push(`${label}抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return null;
    }
  }

  private fundDetailUrl(fundCode: string): string {
    return `${HarvestFundOfficialProvider.baseUrl}/main/fund/${encodeURIComponent(fundCode)}/fundManager.shtml`;
  }

  private navHistoryUrl(fundCode: string): string {
    return `${HarvestFundOfficialProvider.productListUrl.replace(/DetailList\.jsp$/u, "NavHistory.jsp")}?SiteID=1&FundCode=${encodeURIComponent(fundCode)}`;
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

  private async decodeResponse(response: Response, fallbackEncoding: string): Promise<string> {
    const bytes = Buffer.from(await response.arrayBuffer());
    const headerEncoding = HarvestFundOfficialProvider.charsetFrom(response.headers.get("content-type"));
    const headText = bytes.toString("latin1", 0, Math.min(bytes.length, 4096));
    const metaEncoding = HarvestFundOfficialProvider.charsetFrom(headText);
    const encoding = HarvestFundOfficialProvider.normalizeEncoding(headerEncoding ?? metaEncoding ?? fallbackEncoding);
    return new TextDecoder(encoding).decode(bytes);
  }

  private headers(referer?: string): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...(referer ? { referer } : {})
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

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 10) return "fresh";
    if (ageDays <= 30) return "acceptable";
    return "stale";
  }

  private static firstMatch(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    return match?.[1] ? this.stripHtml(match[1]) : undefined;
  }

  private static firstMatchRaw(text: string, pattern: RegExp): string | undefined {
    return pattern.exec(text)?.[1];
  }

  private static stageReturn(key: string, value?: string): Record<string, number> {
    const parsed = this.numberOrUndefined(value);
    if (parsed === undefined) return {};
    return { [key]: /%/u.test(value ?? "") ? Number((parsed / 100).toFixed(6)) : parsed };
  }

  private static dateOrUndefined(value?: string): string | undefined {
    return /^(\d{4}-\d{2}-\d{2})$/u.test(value ?? "") ? value : undefined;
  }

  private static numberOrUndefined(value?: string): number | undefined {
    if (!value || /^[-—\s]+$/u.test(value)) return undefined;
    const parsed = Number(value.replace(/,/gu, "").replace(/%$/u, "").trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<script\b[\s\S]*?<\/script>/giu, "")
      .replace(/<style\b[\s\S]*?<\/style>/giu, "")
      .replace(/<[^>]+>/gu, "")
      .replace(/&#32;/gu, " ")
      .replace(/&emsp;/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static resolveUrl(href: string, pageUrl: string): string | null {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  }

  private static charsetFrom(value: string | null): string | null {
    return /charset=["']?\s*([a-zA-Z0-9_-]+)/iu.exec(value ?? "")?.[1] ?? null;
  }

  private static normalizeEncoding(encoding: string): string {
    const normalized = encoding.toLowerCase();
    if (["gbk", "gb2312", "gb18030"].includes(normalized)) return "gb18030";
    return normalized;
  }

  private static isUnavailablePage(html: string): boolean {
    return /404notfound|Not Found|502 Bad Gateway|此次请求暂不能处理|不存在|无法访问|页面不存在|请稍后/u.test(html);
  }
}
