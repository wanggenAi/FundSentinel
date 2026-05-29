import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface CsrcOfficialReleaseItem {
  title: string;
  url: string;
  published_at: string | null;
  channel_name: string;
  source_name: string;
  summary: string | null;
}

interface CsrcSearchListResponse {
  data?: {
    results?: CsrcSearchListItem[];
    channelName?: string;
  };
  channelName?: string;
}

interface CsrcSearchListItem {
  title?: string;
  subTitle?: string;
  url?: string;
  publishedTimeStr?: string;
  channelName?: string;
  memo?: string;
  content?: string;
  domainMetaList?: Array<{
    domainMetadataName?: string;
    resultList?: Array<{ name?: string; key?: string; value?: string }>;
  }>;
}

const CSRC_NEWS_CHANNEL_ID = "a1a078ee0bc54721ab6b148884c784a8";
const CSRC_NEWS_SEARCH_URL = `https://www.csrc.gov.cn/searchList/${CSRC_NEWS_CHANNEL_ID}?_isAgg=true&_isJson=true&_pageSize=18&_template=index&_rangeTimeGte=&_channelName=&page=1`;

const REGULATORY_KEYWORDS = [
  "基金",
  "公募",
  "私募",
  "证券",
  "期货",
  "监管",
  "行政处罚",
  "跨境",
  "QDII",
  "投资者保护",
  "资本市场",
  "信息披露",
  "销售",
  "业绩比较基准"
];

export class CsrcOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly searchUrl = CSRC_NEWS_SEARCH_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "csrc-official",
      source_name: "China Securities Regulatory Commission Official Provider",
      source_type: "policy",
      trust_level: "A",
      enabled: true,
      priority: 2,
      access_method: `official CSRC searchList JSON endpoint: ${this.searchUrl}`,
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
      freshness_policy: "official CSRC release evidence is fresh within 45 days and acceptable within 120 days",
      notes:
        "Fetches official CSRC releases from the public searchList endpoint. It is regulatory/policy context only, not fund NAV, holdings, trading access, or advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const response = await this.fetchWithTimeout(this.searchUrl);
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`中国证监会 searchList 官方接口返回 HTTP ${response.status}。`], this.searchUrl);
      }

      const items = CsrcOfficialProvider.parseSearchList(await response.text(), this.searchUrl);
      if (!items.length) {
        return this.failure(
          info,
          "No CSRC official releases parsed from searchList endpoint",
          ["中国证监会 searchList 官方接口未返回可解析监管发布。"],
          this.searchUrl
        );
      }

      const keywords = this.keywordsForInput(input);
      const matched = keywords.length ? this.matchItems(items, keywords) : [];
      const selected = (matched.length ? matched : this.fallbackItems(items)).slice(0, 6);
      const latestDate = items.map((item) => item.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "中国证监会官网发布仅作为监管/政策背景证据，不代表单只基金投资建议或买卖结论。",
        "监管发布不可替代基金净值、持仓、定期报告或交易信号。"
      ];
      if (!keywords.length) warnings.push("缺少基金真实上下文监管关键词，返回最新证监会发布作为弱监管背景。");
      else if (!matched.length) warnings.push("未能按基金真实上下文匹配监管关键词，返回最新证监会发布作为弱监管背景。");
      if (freshness === "stale") warnings.push("中国证监会发布列表最新日期偏旧，监管证据应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          policy_signals: selected.map((item) => `${item.published_at ?? "unknown-date"} ${item.title}`),
          news_summaries: selected.map((item) => `${item.source_name}${item.channel_name ? `/${item.channel_name}` : ""}：${item.title}（${item.published_at ?? "日期未知"}）`)
        },
        raw_reference: this.searchUrl,
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
        ["中国证监会 searchList 官方接口抓取失败，Argus 应保留 policy_evidence/industry_news 缺口并尝试 Gov.cn/NDRC 等备用官方政策 provider。"],
        this.searchUrl
      );
    }
  }

  static parseSearchList(text: string, pageUrl = CSRC_NEWS_SEARCH_URL): CsrcOfficialReleaseItem[] {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as CsrcSearchListResponse;
    const results = parsed.data?.results ?? [];
    const channelName = parsed.channelName ?? parsed.data?.channelName ?? "证监会发布";
    return CsrcOfficialProvider.dedupeItems(
      results.flatMap((item) => {
        const title = CsrcOfficialProvider.cleanText(item.title ?? item.subTitle ?? "");
        const url = item.url ? CsrcOfficialProvider.resolveUrl(item.url, pageUrl) : null;
        if (!title || !url) return [];
        return {
          title,
          url,
          published_at: CsrcOfficialProvider.normalizeDate(item.publishedTimeStr),
          channel_name: CsrcOfficialProvider.cleanText(item.channelName ?? channelName),
          source_name: CsrcOfficialProvider.sourceNameFrom(item) ?? "中国证监会",
          summary: CsrcOfficialProvider.summaryFrom(item)
        };
      })
    );
  }

  private matchItems(items: CsrcOfficialReleaseItem[], keywords: string[]): CsrcOfficialReleaseItem[] {
    return items.filter((item) => keywords.some((keyword) => `${item.title}${item.summary ?? ""}`.includes(keyword))).slice(0, 8);
  }

  private fallbackItems(items: CsrcOfficialReleaseItem[]): CsrcOfficialReleaseItem[] {
    const regulatoryItems = items.filter((item) => this.isRegulatoryRelevant(item));
    return regulatoryItems.length ? regulatoryItems : items;
  }

  private keywordsForInput(input: FundDataSourceInput): string[] {
    const configured = process.env[`FUNDSENTINEL_CSRC_KEYWORDS_${input.fund_code}`];
    if (configured) return configured.split(",").map((item) => item.trim()).filter(Boolean);

    const contextText = [
      input.context?.fund_name,
      input.context?.fund_type,
      ...(input.context?.themes ?? []),
      ...(input.context?.portfolio_holdings ?? [])
    ].join(" ");
    const keywords = new Set<string>();
    if (/基金|ETF|LOF|QDII|公募|私募/u.test(contextText)) {
      for (const keyword of ["基金", "公募", "私募", "QDII", "信息披露", "销售", "业绩比较基准"]) keywords.add(keyword);
    }
    if (/港股|香港|H股|跨境|海外|全球|美股/u.test(contextText)) {
      for (const keyword of ["跨境", "H股", "境外", "QDII", "互联互通"]) keywords.add(keyword);
    }
    if (/债|固收|信用/u.test(contextText)) {
      for (const keyword of ["债券", "公司债", "信息披露", "监管"]) keywords.add(keyword);
    }
    return [...keywords];
  }

  private isRegulatoryRelevant(item: CsrcOfficialReleaseItem): boolean {
    const text = `${item.title}${item.summary ?? ""}`;
    return REGULATORY_KEYWORDS.some((keyword) => text.includes(keyword));
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
      accept: "application/json,text/plain,*/*",
      referer: "https://www.csrc.gov.cn/csrc/c100028/common_xq_list.shtml"
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
    if (ageDays <= 45) return "fresh";
    if (ageDays <= 120) return "acceptable";
    return "stale";
  }

  private static sourceNameFrom(item: CsrcSearchListItem): string | null {
    for (const group of item.domainMetaList ?? []) {
      for (const result of group.resultList ?? []) {
        if ((result.key === "infosource" || result.name === "来源" || result.key === "homesource") && result.value) {
          return CsrcOfficialProvider.cleanText(result.value);
        }
      }
    }
    return null;
  }

  private static summaryFrom(item: CsrcSearchListItem): string | null {
    const summary = CsrcOfficialProvider.cleanText(item.memo ?? item.content ?? "");
    return summary ? summary.slice(0, 180) : null;
  }

  private static dedupeItems(items: CsrcOfficialReleaseItem[]): CsrcOfficialReleaseItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.title}|${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private static normalizeDate(value: string | undefined): string | null {
    if (!value) return null;
    const match = /(\d{4})[/-](\d{2})[/-](\d{2})/u.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  private static cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/gu, " ")
      .replace(/&ensp;|&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
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
}
