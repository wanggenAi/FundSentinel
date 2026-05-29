import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface MofFiscalArticleLink {
  title: string;
  url: string;
  published_at: string | null;
  period: string | null;
}

interface FiscalMetricConfig {
  id: string;
  amountName: string;
  yoyName: string;
  pattern: RegExp;
}

const MOF_FISCAL_LIST_URL = "https://www.mof.gov.cn/zhengwuxinxi/redianzhuanti/quanguocaizhengshouzhiqingkuang/";
const MOF_SOURCE_NAME = "Ministry of Finance of the People's Republic of China";

const FISCAL_METRICS: FiscalMetricConfig[] = [
  {
    id: "GENERAL_PUBLIC_BUDGET_REVENUE",
    amountName: "General public budget revenue",
    yoyName: "General public budget revenue year-on-year growth",
    pattern: /全国一般公共预算收入\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "TAX_REVENUE",
    amountName: "Tax revenue",
    yoyName: "Tax revenue year-on-year growth",
    pattern: /全国税收收入\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "NON_TAX_REVENUE",
    amountName: "Non-tax revenue",
    yoyName: "Non-tax revenue year-on-year growth",
    pattern: /非税收入\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "GENERAL_PUBLIC_BUDGET_EXPENDITURE",
    amountName: "General public budget expenditure",
    yoyName: "General public budget expenditure year-on-year growth",
    pattern: /全国一般公共预算支出\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "GOVERNMENT_FUND_BUDGET_REVENUE",
    amountName: "Government fund budget revenue",
    yoyName: "Government fund budget revenue year-on-year growth",
    pattern: /全国政府性基金预算收入\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "LAND_USE_RIGHT_TRANSFER_REVENUE",
    amountName: "State-owned land-use right transfer revenue",
    yoyName: "State-owned land-use right transfer revenue year-on-year growth",
    pattern: /国有土地使用权出让收入\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "GOVERNMENT_FUND_BUDGET_EXPENDITURE",
    amountName: "Government fund budget expenditure",
    yoyName: "Government fund budget expenditure year-on-year growth",
    pattern: /全国政府性基金预算支出\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  },
  {
    id: "INTEREST_PAYMENT_EXPENDITURE",
    amountName: "Debt interest payment expenditure",
    yoyName: "Debt interest payment expenditure year-on-year growth",
    pattern: /债务付息支出\s*([+-]?\d+(?:\.\d+)?)\s*亿元[^。；]*?同比(增长|下降|减少)\s*([+-]?\d+(?:\.\d+)?)%/u
  }
];

export class MofFiscalProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly listUrl = MOF_FISCAL_LIST_URL
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "mof-official",
      source_name: "Ministry of Finance Fiscal Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 45,
      access_method: `official MOF fiscal revenue/expenditure page: ${this.listUrl}`,
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
      freshness_policy: "monthly MOF fiscal revenue/expenditure data should be fresh within 75 days and acceptable within 150 days",
      notes:
        "Fetches official Ministry of Finance fiscal revenue/expenditure statistics from public releases. It is macro/bond-fund context only; fund NAV, holdings, and reports remain separate requirements."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    try {
      const listResponse = await this.fetchWithTimeout(this.listUrl);
      if (!listResponse.ok) {
        return this.failure(info, `HTTP ${listResponse.status}`, [`财政部全国财政收支情况列表页返回 HTTP ${listResponse.status}。`], this.listUrl);
      }

      const link = MofFiscalProvider.parseFiscalArticleLink(await listResponse.text(), this.listUrl);
      if (!link) {
        return this.failure(info, "No MOF fiscal revenue/expenditure article link parsed", ["财政部全国财政收支情况列表页未解析到财政收支文章链接。"], this.listUrl);
      }

      const articleResponse = await this.fetchWithTimeout(link.url);
      if (!articleResponse.ok) {
        return this.failure(info, `HTTP ${articleResponse.status}`, [`财政部财政收支文章返回 HTTP ${articleResponse.status}。`], link.url);
      }

      const fetchedAt = nowIso();
      const indicators = MofFiscalProvider.parseFiscalArticle(await articleResponse.text(), fetchedAt, link.url);
      if (!indicators.length) {
        return this.failure(info, "No usable MOF fiscal observations parsed", ["财政部财政收支文章未解析到核心财政收支金额和同比指标。"], link.url);
      }

      const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "财政部财政收支统计是官方财政/债基宏观背景，只能辅助 Logos/Atlas 判断财政环境，不代表单只基金投资结论。",
        "财政部财政收支统计不可替代基金净值、持仓、定期报告等核心基金证据。"
      ];
      if (freshness === "stale") warnings.push("财政部财政收支数据最新月份偏旧，后续硬逻辑判断必须降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          macro_indicators: indicators
        },
        raw_reference: link.url,
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
        ["财政部官方财政收支抓取失败，Argus 应保留 macro_data 缺口并尝试 PBC/StatsGov/SAFE/World Bank/IMF/FRED 等备用宏观 provider。"],
        this.listUrl
      );
    }
  }

  static parseFiscalArticleLink(html: string, pageUrl = MOF_FISCAL_LIST_URL): MofFiscalArticleLink | null {
    const candidates = [...html.matchAll(/<li>\s*<a\s+([^>]*)>([\s\S]*?)<\/a>\s*<span>([^<]+)<\/span>/giu)]
      .map((match) => {
        const attrs = match[1] ?? "";
        const href = MofFiscalProvider.attributeValue(attrs, "href");
        const titleAttr = MofFiscalProvider.attributeValue(attrs, "title");
        const title = MofFiscalProvider.stripHtml(titleAttr ?? match[2] ?? "");
        const publishedAt = MofFiscalProvider.dateFrom(match[3] ?? "");
        return {
          title,
          href,
          published_at: publishedAt,
          period: MofFiscalProvider.periodFrom(title)
        };
      })
      .filter((candidate) => candidate.href && /财政收支情况/u.test(candidate.title) && candidate.period)
      .sort((a, b) => (b.period ?? "").localeCompare(a.period ?? ""));

    const latest = candidates[0];
    if (!latest?.href) return null;
    return {
      title: latest.title,
      url: MofFiscalProvider.resolveUrl(latest.href, pageUrl),
      published_at: latest.published_at,
      period: latest.period
    };
  }

  static parseFiscalArticle(
    html: string,
    fetchedAt = nowIso(),
    sourceUrl = "mof-fiscal-test"
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const articleTitle = MofFiscalProvider.metaContent(html, "ArticleTitle");
    const text = MofFiscalProvider.stripHtml(html);
    const date = MofFiscalProvider.periodFrom(`${articleTitle ?? ""} ${text}`) ?? MofFiscalProvider.dateFrom(text);
    if (!date) return [];

    return FISCAL_METRICS.flatMap((metric) => {
      const match = text.match(metric.pattern);
      if (!match) return [];
      const amount = Number(match[1]);
      const yoy = MofFiscalProvider.signedPercent(match[2] ?? "", match[3] ?? "");
      if (!Number.isFinite(amount) || !Number.isFinite(yoy)) return [];
      return [
        {
          country_code: "CN",
          country_name: "China",
          indicator_id: `CN.MOF.${metric.id}_CNY`,
          indicator_name: metric.amountName,
          value: amount,
          date,
          unit: "100 million yuan",
          source_url: sourceUrl,
          source_name: MOF_SOURCE_NAME,
          fetched_at: fetchedAt
        },
        {
          country_code: "CN",
          country_name: "China",
          indicator_id: `CN.MOF.${metric.id}_YOY`,
          indicator_name: metric.yoyName,
          value: yoy,
          date,
          unit: "percent",
          source_url: sourceUrl,
          source_name: MOF_SOURCE_NAME,
          fetched_at: fetchedAt
        }
      ];
    });
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
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date || !/^\d{4}-\d{2}$/u.test(date)) return "unknown";
    const ageDays = (Date.now() - new Date(`${date}-01T00:00:00.000Z`).getTime()) / 86_400_000;
    if (ageDays <= 75) return "fresh";
    if (ageDays <= 150) return "acceptable";
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

  private static signedPercent(direction: string, rawValue: string): number {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return Number.NaN;
    return /下降|减少/u.test(direction) ? -Math.abs(value) : value;
  }

  private static stripHtml(value: string): string {
    return value
      .replace(/<script[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<br\s*\/?>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/&nbsp;/gu, " ")
      .replace(/&amp;/gu, "&")
      .replace(/\u00a0/gu, " ")
      .replace(/[—－]/gu, "-")
      .replace(/\s+/gu, "")
      .trim();
  }

  private static periodFrom(value: string): string | null {
    const normalized = MofFiscalProvider.stripHtml(value);
    const rangeMatch = normalized.match(/(20\d{2})年(?:1[-—－]|\d+[-—－])?(\d{1,2})月财政收支情况/u);
    if (rangeMatch) return `${rangeMatch[1]}-${rangeMatch[2]!.padStart(2, "0")}`;
    const quarterMatch = normalized.match(/(20\d{2})年(?:一季度|1季度|前一季度|第一季度)财政收支情况/u);
    if (quarterMatch) return `${quarterMatch[1]}-03`;
    const halfMatch = normalized.match(/(20\d{2})年上半年财政收支情况/u);
    if (halfMatch) return `${halfMatch[1]}-06`;
    const threeQuarterMatch = normalized.match(/(20\d{2})年前三季度财政收支情况/u);
    if (threeQuarterMatch) return `${threeQuarterMatch[1]}-09`;
    const annualMatch = normalized.match(/(20\d{2})年财政收支情况/u);
    if (annualMatch) return `${annualMatch[1]}-12`;
    return null;
  }

  private static dateFrom(value: string): string | null {
    const match = value.match(/(20\d{2})[-年](\d{1,2})[-月](\d{1,2})/u);
    if (!match) return null;
    return `${match[1]}-${match[2]!.padStart(2, "0")}`;
  }

  private static attributeValue(attrs: string, name: string): string | null {
    const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "iu"));
    return match?.[1] ?? null;
  }

  private static metaContent(html: string, name: string): string | null {
    const metaMatch = html.match(new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*>`, "iu"));
    return metaMatch ? MofFiscalProvider.attributeValue(metaMatch[0], "content") : null;
  }

  private static resolveUrl(href: string, pageUrl: string): string {
    return new URL(href, pageUrl).toString();
  }
}
