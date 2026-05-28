import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export interface OfficialPolicyNewsItem {
  title: string;
  url: string;
  published_at: string | null;
  source_name: string;
}

const NDRC_NEWS_URL = "https://www.ndrc.gov.cn/xwdt/xwfb/";

const THEME_KEYWORDS: Record<string, string[]> = {
  technology: ["科技", "人工智能", "数字", "数据", "算力", "创新"],
  semiconductor: ["集成电路", "半导体", "芯片"],
  new_energy: ["能源", "电力", "绿色", "碳达峰", "碳中和", "新能源", "成品油"],
  infrastructure: ["基础设施", "城市更新", "交通", "建设"],
  finance: ["金融", "资本市场", "债券", "基金", "投资", "民营企业"],
  consumption: ["消费", "内需", "服务业", "居民"],
  manufacturing: ["制造", "汽车", "航空", "设备", "产业"]
};

export class PolicyNewsProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "policy-news",
      source_name: "Official Policy and Industry News Provider",
      source_type: "policy",
      trust_level: "A",
      enabled: true,
      priority: 30,
      access_method: `official NDRC news page: ${NDRC_NEWS_URL}`,
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
      freshness_policy: "official policy/news evidence is fresh within 45 days and acceptable within 120 days",
      notes: "Fetches official NDRC policy/news releases as industry-policy context. It is supporting evidence only, never fund advice."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const response = await this.fetchWithTimeout(NDRC_NEWS_URL, {
        headers: this.headers()
      });
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`国家发展改革委新闻发布页返回 HTTP ${response.status}。`], NDRC_NEWS_URL);
      }

      const html = await response.text();
      const items = PolicyNewsProvider.parseNdrcNewsList(html, NDRC_NEWS_URL);
      if (!items.length) {
        return this.failure(info, "No official policy/news items parsed from NDRC page", ["国家发展改革委新闻发布页未返回可解析的政策/新闻列表。"], NDRC_NEWS_URL);
      }

      const matched = this.matchItems(items, input);
      const selected = (matched.length ? matched : items).slice(0, 6);
      const latestDate = items.map((item) => item.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = ["官方政策/行业新闻只能作为 Logos 的背景证据，不代表单只基金投资建议或买卖结论。"];
      if (!matched.length) warnings.push("未能按基金真实上下文匹配行业关键词，返回最新官方新闻作为弱宏观背景。");
      if (freshness === "stale") warnings.push("国家发展改革委新闻发布页最新日期偏旧，行业新闻证据应降级。");

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
          news_summaries: selected.map((item) => `${item.source_name}：${item.title}（${item.published_at ?? "日期未知"}）`)
        },
        raw_reference: NDRC_NEWS_URL,
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
        ["国家发展改革委新闻发布页抓取失败，Argus 应保留 policy_evidence/industry_news 缺口并尝试其他官方政策 provider。"],
        NDRC_NEWS_URL
      );
    }
  }

  static parseNdrcNewsList(html: string, pageUrl = NDRC_NEWS_URL): OfficialPolicyNewsItem[] {
    const items: OfficialPolicyNewsItem[] = [];
    const pattern = /<li>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>\s*<span>(\d{4}\/\d{2}\/\d{2})<\/span>\s*<\/li>/giu;
    for (const match of html.matchAll(pattern)) {
      const url = this.resolveUrl(match[1] ?? "", pageUrl);
      const title = this.decodeHtml(match[2] ?? "").trim();
      const publishedAt = this.normalizeDate(match[3]);
      if (!url || !title) continue;
      items.push({
        title,
        url,
        published_at: publishedAt,
        source_name: "国家发展改革委"
      });
    }
    return this.dedupeItems(items);
  }

  private matchItems(items: OfficialPolicyNewsItem[], input: FundDataSourceInput): OfficialPolicyNewsItem[] {
    const keywords = this.keywordsForInput(input);
    if (!keywords.length) return [];
    return items.filter((item) => keywords.some((keyword) => item.title.includes(keyword))).slice(0, 8);
  }

  private keywordsForInput(input: FundDataSourceInput): string[] {
    const configured = process.env[`FUNDSENTINEL_POLICY_NEWS_KEYWORDS_${input.fund_code}`];
    if (configured) return configured.split(",").map((item) => item.trim()).filter(Boolean);

    const contextText = [
      input.context?.fund_name,
      input.context?.fund_type,
      ...(input.context?.themes ?? []),
      ...(input.context?.portfolio_holdings ?? [])
    ].join(" ");
    const keywords = new Set<string>();
    for (const [theme, themeKeywords] of Object.entries(THEME_KEYWORDS)) {
      if (themeKeywords.some((keyword) => contextText.includes(keyword))) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "new_energy" && /新能源|光伏|储能|电池|绿色|油气|能源/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "finance" && /债|固收|信用|金融|银行|券商/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "technology" && /科技|AI|人工智能|算力|数字/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
    }
    return [...keywords];
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: "https://www.ndrc.gov.cn/"
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

  private static dedupeItems(items: OfficialPolicyNewsItem[]): OfficialPolicyNewsItem[] {
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

  private static resolveUrl(href: string, pageUrl: string): string | null {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  }

  private static decodeHtml(value: string): string {
    return value
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'");
  }
}
