import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface SseMarketCalendarEvent {
  event_type: "ipo" | "shareholder_meeting" | "roadshow" | "e_interview" | "dividend" | "exchange_news" | "exchange_notice" | "other";
  event_date: string;
  security_code: string | null;
  security_name: string | null;
  title: string;
  source_name: string;
  source_url: string;
}

interface SseQueryResponse<T> {
  result?: T[];
  pageHelp?: {
    total?: number;
    pageNo?: number;
    pageSize?: number;
  };
}

interface SseCalendarRow {
  stockCode?: string;
  stockAbbr?: string;
  bizType?: string | number;
  bizTypeDesc?: string;
  subTypeDesc?: string;
  title?: string;
  tradeBeginDate?: string;
}

interface SseShareholderMeetingRow {
  SEC_CODE?: string;
  SEC_NAME_CN?: string;
  CONVENE_DATE?: string;
  CONVENE_SITE_DATE?: string;
  CONVENE_END_DATE?: string;
  EQUITY_DATE?: string;
  ID?: string;
}

const SSE_MARKET_CALENDAR_PAGE = "https://www.sse.com.cn/disclosure/dealinstruc/calendar/index.shtml";
const SSE_QUERY_BASE = "https://query.sse.com.cn";
const SZSE_NEWS_PAGE = "https://www.szse.cn/aboutus/trends/news/";
const SZSE_NOTICE_PAGE = "https://www.szse.cn/disclosure/notice/general/";

export class SseMarketCalendarProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly calendarDate = SseMarketCalendarProvider.todayShanghaiDate()
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "sse-szse-official",
      source_name: "Shanghai/Shenzhen Stock Exchange Official Market Event Provider",
      source_type: "news",
      trust_level: "A",
      enabled: true,
      priority: 35,
      access_method:
        "official SSE market-calendar query endpoints plus SZSE official news/notice pages: https://www.sse.com.cn/disclosure/dealinstruc/calendar/index.shtml and https://www.szse.cn/aboutus/trends/news/",
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
      freshness_policy: "official exchange calendar events should be same-day fresh and acceptable within 10 days",
      notes:
        "Fetches official SSE market-calendar events and SZSE official news/notice items. It is market context only, not NAV, holdings, fund reports, trading access, or advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["industry_news", "policy_evidence"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const warnings: string[] = [];
    const eventGroups = await Promise.all([
      this.fetchCalendarEvents("ipo", 1, warnings),
      this.fetchCalendarEvents("roadshow", 2, warnings),
      this.fetchShareholderMeetings(warnings),
      this.fetchSzseOfficialItems(SZSE_NEWS_PAGE, "exchange_news", warnings),
      this.fetchSzseOfficialItems(SZSE_NOTICE_PAGE, "exchange_notice", warnings)
    ]);
    const events = SseMarketCalendarProvider.dedupeEvents(eventGroups.flat()).slice(0, 12);

    if (!events.length && warnings.length >= eventGroups.length) {
      return this.failure(
        info,
        warnings.join(" | ") || "No usable SSE official market-calendar responses",
        ["上交所/深交所官方市场事件来源未返回可用事件，Argus 应保留 industry_news/market_calendar 缺口并尝试其他官方交易所来源。"],
        SSE_MARKET_CALENDAR_PAGE
      );
    }

    const freshness = this.freshnessFor(this.isoDateFromCompact(this.calendarDate));
    const resultWarnings = [
      ...warnings,
      "上交所/深交所官方市场事件仅作为市场背景，不代表单只基金投资建议或买卖结论。",
      "交易所市场事件不可替代基金净值、持仓、定期报告或交易信号。"
    ];
    if (!events.length) resultWarnings.push("上交所/深交所官方市场事件源未返回可归档事件，行业新闻/市场事件证据仍应降级。");
    if (freshness === "stale") resultWarnings.push("交易所市场事件查询日期偏旧，市场事件证据应降级。");

    return {
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: events.length ? "partial" : "unavailable",
      success: true,
      data: {
        fund_code: input.fund_code,
        news_summaries: events.map((event) => SseMarketCalendarProvider.summaryFor(event))
      },
      raw_reference: SSE_MARKET_CALENDAR_PAGE,
      fetched_at: nowIso(),
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseCalendarResponse(text: string, eventType: SseMarketCalendarEvent["event_type"], sourceUrl: string): SseMarketCalendarEvent[] {
    const parsed = this.parseJsonOrJsonp<SseQueryResponse<SseCalendarRow>>(text);
    return (parsed.result ?? [])
      .map((row) => {
        const date = this.isoDateFromCompact(row.tradeBeginDate) ?? "unknown-date";
        const title = this.cleanText(row.title ?? row.subTypeDesc ?? row.bizTypeDesc ?? "");
        if (!title && !row.stockCode && !row.stockAbbr) return null;
        return {
          event_type: eventType,
          event_date: date,
          security_code: this.cleanText(row.stockCode ?? "") || null,
          security_name: this.cleanText(row.stockAbbr ?? "") || null,
          title: title || this.defaultTitleFor(eventType, row),
          source_name: "上海证券交易所",
          source_url: sourceUrl
        };
      })
      .filter((item) => item !== null);
  }

  static parseShareholderMeetingResponse(text: string, sourceUrl: string): SseMarketCalendarEvent[] {
    const parsed = this.parseJsonOrJsonp<SseQueryResponse<SseShareholderMeetingRow>>(text);
    return (parsed.result ?? [])
      .map((row) => {
        const date = this.isoDateFromCompact(row.CONVENE_DATE) ?? this.isoDateFromCompact(row.CONVENE_SITE_DATE) ?? "unknown-date";
        const securityCode = this.cleanText(row.SEC_CODE ?? "");
        const securityName = this.cleanText(row.SEC_NAME_CN ?? "");
        if (!securityCode && !securityName) return null;
        const siteDate = this.isoDateFromCompact(row.CONVENE_SITE_DATE);
        return {
          event_type: "shareholder_meeting" as const,
          event_date: date,
          security_code: securityCode || null,
          security_name: securityName || null,
          title: `${securityName || securityCode} 股东会${siteDate ? `（现场会议日 ${siteDate}）` : ""}`,
          source_name: "上海证券交易所",
          source_url: sourceUrl
        };
      })
      .filter((item) => item !== null);
  }

  static parseSzseListPage(text: string, pageUrl: string, eventType: "exchange_news" | "exchange_notice"): SseMarketCalendarEvent[] {
    const items: SseMarketCalendarEvent[] = [];
    const blockPattern = /<li\b[^>]*>[\s\S]*?<\/li>/giu;
    for (const match of text.matchAll(blockPattern)) {
      const itemHtml = match[0] ?? "";
      const href = this.jsVarValue(itemHtml, "curHref") ?? this.attributeValue(itemHtml, "href");
      const title = this.cleanText(this.jsVarValue(itemHtml, "curTitle") ?? this.attributeValue(itemHtml, "title") ?? "");
      const eventDate = this.dateFromHtml(itemHtml);
      if (!href || !title || !eventDate) continue;
      items.push({
        event_type: eventType,
        event_date: eventDate,
        security_code: null,
        security_name: null,
        title,
        source_name: "深圳证券交易所",
        source_url: this.resolveUrl(href, pageUrl)
      });
    }
    return this.dedupeEvents(items);
  }

  static parseJsonOrJsonp<T>(text: string): T {
    const trimmed = text.trim().replace(/^\uFEFF/u, "");
    const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.replace(/^[^(]*\(/u, "").replace(/\)\s*;?\s*$/u, "");
    return JSON.parse(jsonText) as T;
  }

  static todayShanghaiDate(): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}${values.month}${values.day}`;
  }

  private async fetchCalendarEvents(
    eventType: SseMarketCalendarEvent["event_type"],
    bizType: number,
    warnings: string[]
  ): Promise<SseMarketCalendarEvent[]> {
    const url = this.calendarEventUrl(bizType);
    try {
      const response = await this.fetchWithTimeout(url);
      const text = await response.text();
      if (!response.ok) {
        warnings.push(`上交所市场日历 ${eventType} 接口返回 HTTP ${response.status}。`);
        return [];
      }
      return SseMarketCalendarProvider.parseCalendarResponse(text, eventType, url);
    } catch (error) {
      warnings.push(`上交所市场日历 ${eventType} 接口抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return [];
    }
  }

  private async fetchShareholderMeetings(warnings: string[]): Promise<SseMarketCalendarEvent[]> {
    const url = this.shareholderMeetingUrl();
    try {
      const response = await this.fetchWithTimeout(url);
      const text = await response.text();
      if (!response.ok) {
        warnings.push(`上交所股东会日历接口返回 HTTP ${response.status}。`);
        return [];
      }
      return SseMarketCalendarProvider.parseShareholderMeetingResponse(text, url);
    } catch (error) {
      warnings.push(`上交所股东会日历接口抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return [];
    }
  }

  private async fetchSzseOfficialItems(
    pageUrl: string,
    eventType: "exchange_news" | "exchange_notice",
    warnings: string[]
  ): Promise<SseMarketCalendarEvent[]> {
    try {
      const response = await this.fetchWithTimeout(pageUrl, "https://www.szse.cn/");
      const text = await response.text();
      if (!response.ok) {
        warnings.push(`深交所 ${eventType} 页面返回 HTTP ${response.status}。`);
        return [];
      }
      return SseMarketCalendarProvider.parseSzseListPage(text, pageUrl, eventType).slice(0, 6);
    } catch (error) {
      warnings.push(`深交所 ${eventType} 页面抓取失败：${error instanceof Error ? error.message : String(error)}。`);
      return [];
    }
  }

  private calendarEventUrl(bizType: number): string {
    const params = new URLSearchParams({
      isPagination: "true",
      order: "tradeBeginDate|desc,stockCode|desc",
      tradeBeginDate: this.calendarDate,
      tradeEndDate: this.calendarDate,
      sqlId: "PL_SCRL_SCRLB",
      "pageHelp.pageNo": "1",
      "pageHelp.beginPage": "1",
      "pageHelp.cacheSize": "1",
      "pageHelp.endPage": "1",
      "pageHelp.pageSize": bizType === 1 ? "25" : "100",
      bizType: String(bizType)
    });
    return `${SSE_QUERY_BASE}/commonSoaQuery.do?${params.toString()}`;
  }

  private shareholderMeetingUrl(): string {
    const params = new URLSearchParams({
      sqlId: "COMMON_SSE_SCFW_TZZFW_GDDHWLTPZL_L",
      conveneDate: this.calendarDate
    });
    return `${SSE_QUERY_BASE}/commonQuery.do?${params.toString()}`;
  }

  private async fetchWithTimeout(url: string, referer = SSE_MARKET_CALENDAR_PAGE): Promise<Response> {
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
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      accept: "application/json,text/javascript,text/html,*/*",
      referer
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

  private freshnessFor(date: string | null): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const ageDays = Math.abs(Date.now() - new Date(`${date}T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 3) return "fresh";
    if (ageDays <= 10) return "acceptable";
    return "stale";
  }

  private isoDateFromCompact(value?: string | null): string | null {
    return SseMarketCalendarProvider.isoDateFromCompact(value);
  }

  private static isoDateFromCompact(value?: string | null): string | null {
    if (!value) return null;
    const compact = value.replace(/\D/gu, "");
    if (!/^\d{8}$/u.test(compact)) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  }

  private static defaultTitleFor(eventType: SseMarketCalendarEvent["event_type"], row: SseCalendarRow): string {
    const label =
      eventType === "ipo"
        ? "IPO 日历"
        : eventType === "roadshow"
          ? "路演信息"
          : eventType === "e_interview"
            ? "e 访谈信息"
            : eventType === "exchange_news"
              ? "交易所要闻"
              : eventType === "exchange_notice"
                ? "交易所公告"
                : "市场日历事件";
    return `${row.stockAbbr ?? row.stockCode ?? "证券"} ${label}`;
  }

  private static summaryFor(event: SseMarketCalendarEvent): string {
    const security = [event.security_code, event.security_name].filter(Boolean).join(" ");
    return `${event.source_name}/市场日历：${event.event_date} ${security ? `${security} ` : ""}${event.title}`;
  }

  private static dedupeEvents(events: SseMarketCalendarEvent[]): SseMarketCalendarEvent[] {
    const seen = new Set<string>();
    return events.filter((event) => {
      const key = `${event.event_type}|${event.event_date}|${event.security_code ?? ""}|${event.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private static cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/gu, " ")
      .replace(/&ensp;|&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim();
  }

  private static jsVarValue(text: string, name: string): string | null {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`var\\s+${escaped}\\s*=\\s*['"]([\\s\\S]*?)['"]\\s*;`, "u").exec(text);
    return match?.[1] ? this.cleanText(match[1]) : null;
  }

  private static attributeValue(text: string, name: string): string | null {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "iu").exec(text);
    return match?.[1] ?? null;
  }

  private static dateFromHtml(text: string): string | null {
    const match = /(\d{4})[-年](\d{1,2})[-月](\d{1,2})/u.exec(text);
    if (!match) return null;
    return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
