import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export type MiitOfficialItemCategory =
  | "policy_file"
  | "policy_interpretation"
  | "industry_data"
  | "industry_news"
  | "news_release"
  | "public_consultation";

export interface MiitOfficialItem {
  title: string;
  url: string;
  published_at: string | null;
  category: MiitOfficialItemCategory;
  source_name: string;
}

const MIIT_HOME_URL = "https://www.miit.gov.cn/index.html";

const THEME_KEYWORDS: Record<string, string[]> = {
  ai: ["人工智能", "算力", "大模型", "智能", "智能制造"],
  digital_economy: ["数字", "数据", "软件", "互联网", "工业互联网", "信息化", "元宇宙"],
  telecom: ["通信", "电信", "5G", "6G", "无线", "卫星", "Redcap"],
  semiconductor: ["集成电路", "半导体", "芯片", "电子信息", "电子"],
  manufacturing: ["制造", "工业", "装备", "高端装备", "机器人", "标准化", "工业产品", "质量"],
  new_energy_vehicle: ["新能源汽车", "新能源", "动力电池", "电池", "回收利用", "汽车"],
  green: ["绿色", "低碳", "节能", "有害物质", "碳"],
  materials: ["新材料", "稀土", "有色金属", "钢铁", "化工"],
  medicine: ["医药", "医疗", "生物医药"]
};

export class MiitOfficialProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly homepageUrl = MIIT_HOME_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "miit-official",
      source_name: "Ministry of Industry and Information Technology Official Provider",
      source_type: "policy",
      trust_level: "A",
      enabled: true,
      priority: 42,
      access_method: `official MIIT homepage static policy/data lists: ${this.homepageUrl}`,
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
      freshness_policy: "official MIIT policy/data/news evidence is fresh within 45 days and acceptable within 120 days",
      notes:
        "Fetches MIIT official homepage policy, policy-interpretation, industry-data, and industry-news lists as manufacturing/digital-economy context only."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const response = await this.fetchWithTimeout(this.homepageUrl);
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`工业和信息化部官网首页返回 HTTP ${response.status}。`], this.homepageUrl);
      }

      const items = MiitOfficialProvider.parseHomepageItems(await response.text(), this.homepageUrl);
      if (!items.length) {
        return this.failure(
          info,
          "No MIIT official items parsed from homepage",
          ["工业和信息化部官网首页未返回可解析的政策、数据或行业新闻列表。"],
          this.homepageUrl
        );
      }

      const keywords = this.keywordsForInput(input);
      const matched = keywords.length ? this.matchItems(items, keywords) : [];
      const selected = (matched.length ? matched : this.fallbackItems(items)).slice(0, 6);
      const latestDate = items.map((item) => item.published_at).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "工业和信息化部官网发布仅作为制造业、数字经济、通信、产业政策背景证据，不能直接补齐单只基金核心证据。",
        "工信部政策/行业数据不可替代基金净值、持仓或定期报告。"
      ];
      if (!keywords.length) warnings.push("缺少基金真实上下文产业关键词，返回最新工信部发布作为弱产业背景。");
      else if (!matched.length) warnings.push("未能按基金真实上下文匹配工信部产业关键词，返回最新工信部发布作为弱产业背景。");
      if (freshness === "stale") warnings.push("工业和信息化部官网首页最新日期偏旧，产业政策证据应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          policy_signals: selected.map((item) => `${item.published_at ?? "unknown-date"} ${MiitOfficialProvider.categoryLabel(item.category)} ${item.title}`),
          news_summaries: selected.map(
            (item) => `${item.source_name}/${MiitOfficialProvider.categoryLabel(item.category)}：${item.title}（${item.published_at ?? "日期未知"}）`
          )
        },
        raw_reference: this.homepageUrl,
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
        ["工业和信息化部官网首页抓取失败，Argus 应保留 policy_evidence/industry_news 缺口并尝试 Gov.cn/NDRC 等备用官方政策 provider。"],
        this.homepageUrl
      );
    }
  }

  static parseHomepageItems(html: string, pageUrl = MIIT_HOME_URL): MiitOfficialItem[] {
    const items: MiitOfficialItem[] = [];
    const listItemPattern = /<li\b[^>]*>[\s\S]*?<\/li>/giu;
    for (const match of html.matchAll(listItemPattern)) {
      const itemHtml = match[0] ?? "";
      const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*(?:title=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/a>/iu.exec(itemHtml);
      if (!anchor) continue;

      const url = MiitOfficialProvider.resolveUrl(anchor[1] ?? "", pageUrl);
      const category = url ? MiitOfficialProvider.categoryForUrl(url) : null;
      if (!url || !category) continue;

      const title = MiitOfficialProvider.cleanText(anchor[2] || anchor[3] || "");
      const publishedAt = MiitOfficialProvider.normalizeDate(itemHtml);
      if (!title || !publishedAt) continue;

      items.push({
        title,
        url,
        published_at: publishedAt,
        category,
        source_name: "工业和信息化部"
      });
    }
    return MiitOfficialProvider.dedupeItems(items);
  }

  private matchItems(items: MiitOfficialItem[], keywords: string[]): MiitOfficialItem[] {
    return items.filter((item) => keywords.some((keyword) => item.title.includes(keyword))).slice(0, 10);
  }

  private fallbackItems(items: MiitOfficialItem[]): MiitOfficialItem[] {
    const preferredCategories: MiitOfficialItemCategory[] = ["policy_file", "policy_interpretation", "industry_data", "public_consultation"];
    const preferred = items.filter((item) => preferredCategories.includes(item.category));
    return preferred.length ? preferred : items;
  }

  private keywordsForInput(input: FundDataSourceInput): string[] {
    const configured = process.env[`FUNDSENTINEL_MIIT_KEYWORDS_${input.fund_code}`];
    if (configured) return configured.split(",").map((item) => item.trim()).filter(Boolean);

    const contextText = [
      input.context?.fund_name,
      input.context?.fund_type,
      ...(input.context?.themes ?? []),
      ...(input.context?.portfolio_holdings ?? [])
    ].join(" ");
    if (!contextText.trim()) return [];

    const keywords = new Set<string>();
    for (const [theme, themeKeywords] of Object.entries(THEME_KEYWORDS)) {
      if (themeKeywords.some((keyword) => contextText.includes(keyword))) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "ai" && /AI|人工智能|算力|大模型/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "digital_economy" && /TMT|软件|互联网|数字|数据|信息技术/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "new_energy_vehicle" && /新能源|电池|汽车|储能|光伏/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "manufacturing" && /制造|装备|机器人|工业|机械|军工/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "semiconductor" && /半导体|芯片|集成电路|电子/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
    }
    return [...keywords];
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
          referer: "https://www.miit.gov.cn/"
        }
      });
    } finally {
      clearTimeout(timeout);
    }
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

  private static categoryForUrl(url: string): MiitOfficialItemCategory | null {
    const pathname = new URL(url).pathname;
    if (pathname.includes("/zwgk/zcwj/") || pathname.includes("/xwfb/zxzc/")) return "policy_file";
    if (pathname.includes("/zwgk/zcjd/")) return "policy_interpretation";
    if (pathname.includes("/gxsj/")) return "industry_data";
    if (pathname.includes("/xwfb/xwfbh/")) return "news_release";
    if (pathname.includes("/xwfb/gxdt/") || pathname.includes("/xwfb/bldhd/")) return "industry_news";
    if (pathname.includes("/zwgk/wjgs/") || pathname.includes("/gzcy/yjzj/")) return "public_consultation";
    return null;
  }

  private static categoryLabel(category: MiitOfficialItemCategory): string {
    const labels: Record<MiitOfficialItemCategory, string> = {
      policy_file: "政策文件",
      policy_interpretation: "政策解读",
      industry_data: "工信数据",
      industry_news: "工信动态",
      news_release: "新闻发布",
      public_consultation: "文件公示/意见征集"
    };
    return labels[category];
  }

  private static dedupeItems(items: MiitOfficialItem[]): MiitOfficialItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.title}|${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private static normalizeDate(value: string): string | null {
    const match = /(\d{4})[/-](\d{2})[/-](\d{2})/u.exec(value);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  private static resolveUrl(href: string, pageUrl: string): string | null {
    try {
      return new URL(href, pageUrl).toString().replace(/^http:\/\/www\.miit\.gov\.cn/u, "https://www.miit.gov.cn");
    } catch {
      return null;
    }
  }

  private static cleanText(value: string): string {
    return value
      .replace(/<[^>]+>/gu, "")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/\s+/gu, " ")
      .trim();
  }
}
