import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface StatsGovIndicatorConfig {
  id: string;
  name: string;
  unit: string | null;
}

interface StatsGovNode {
  code?: string;
  name?: string;
  cname?: string;
  value?: string | number | null;
  data?: {
    data?: string | number | null;
    dotcount?: number;
    hasdata?: boolean;
    strdata?: string;
  };
  wds?: Array<{ wdcode?: string; valuecode?: string }>;
}

interface StatsGovResponse {
  returncode?: number;
  returndata?: {
    datanodes?: StatsGovNode[];
    wdnodes?: Array<{
      wdcode?: string;
      nodes?: Array<{ code?: string; name?: string; cname?: string }>;
    }>;
  };
}

const DEFAULT_INDICATORS: StatsGovIndicatorConfig[] = [
  { id: "A020101", name: "GDP current-price total", unit: "100 million CNY" },
  { id: "A01010101", name: "Resident consumer price index", unit: "index" },
  { id: "A030101", name: "Industrial added value", unit: "100 million CNY" }
];

export class StatsGovMacroProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  private static readonly baseUrl = "https://data.stats.gov.cn/easyquery.htm";

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly indicators = DEFAULT_INDICATORS
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "stats-gov-cn",
      source_name: "National Bureau of Statistics Macro Provider",
      source_type: "macro_data",
      trust_level: "A",
      enabled: true,
      priority: 44,
      access_method: "official National Data endpoint probe: https://data.stats.gov.cn/easyquery.htm",
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
      freshness_policy: "annual official macro indicators should be fresh within 18 months and acceptable within 30 months",
      notes: "Attempts the official National Data endpoint for China macro/industry indicators. WAF or blocked access is surfaced as a data gap."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("macro_data");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const fetchedAt = nowIso();
    const indicators: NonNullable<ProviderFundPayload["macro_indicators"]> = [];
    const failures: string[] = [];
    const warnings: string[] = [];
    let lastReference: string | null = null;

    for (const indicator of this.indicators) {
      const url = this.indicatorUrl(indicator.id);
      lastReference = url;
      try {
        const response = await this.fetchWithTimeout(url);
        const text = await response.text();
        if (!response.ok) {
          failures.push(`${indicator.id} HTTP ${response.status}`);
          warnings.push(`国家统计局国家数据接口返回 HTTP ${response.status}，该指标无法自动获取。`);
          continue;
        }
        if (StatsGovMacroProvider.isBlockedPage(text)) {
          failures.push(`${indicator.id} blocked by site protection`);
          warnings.push("国家统计局国家数据接口疑似触发站点防护，不能将其视为可用数据源。");
          continue;
        }
        indicators.push(...StatsGovMacroProvider.parseIndicatorResponse(text, indicator, fetchedAt, url));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${indicator.id} ${message}`);
        warnings.push(`国家统计局 provider 抓取失败：${message}。`);
      }
    }

    if (!indicators.length) {
      return this.failure(
        info,
        failures.length ? failures.join(" | ") : "No usable Stats.gov.cn macro observations returned",
        [
          ...warnings,
          "Argus 已记录国家统计局官方宏观数据缺口。建议改用允许的官方下载入口、人工导入统计表，或接入具备授权的数据 API。"
        ],
        lastReference
      );
    }

    const latestDate = indicators.map((indicator) => indicator.date).sort().at(-1);
    const freshness = this.freshnessFor(latestDate);
    const resultWarnings = [
      ...warnings,
      "国家统计局宏观指标是官方宏观/行业背景，只能辅助 Logos/Atlas 判断环境，不代表单只基金投资结论。",
      "国家统计局指标不可替代基金净值、持仓、定期报告或交易信号。"
    ];
    if (freshness === "stale") resultWarnings.push("国家统计局宏观指标最新期偏旧，后续硬逻辑判断必须降级。");

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
      raw_reference: StatsGovMacroProvider.baseUrl,
      fetched_at: fetchedAt,
      freshness,
      warnings: resultWarnings,
      error: null,
      is_demo: false
    };
  }

  static parseIndicatorResponse(
    text: string,
    fallbackConfig: StatsGovIndicatorConfig,
    fetchedAt = nowIso(),
    sourceUrl = StatsGovMacroProvider.baseUrl
  ): NonNullable<ProviderFundPayload["macro_indicators"]> {
    const parsed = JSON.parse(text) as StatsGovResponse;
    const nodes = parsed.returndata?.datanodes ?? [];
    const timeNames = this.timeNodeNames(parsed);
    return nodes
      .map((node) => {
        const value = this.numericValueFor(node);
        const date = this.dateFor(node, timeNames);
        if (!Number.isFinite(value) || !date) return null;
        return {
          country_code: "CN",
          country_name: "China",
          indicator_id: this.indicatorIdFor(node) ?? fallbackConfig.id,
          indicator_name: fallbackConfig.name,
          value,
          date,
          unit: fallbackConfig.unit,
          source_url: sourceUrl,
          source_name: "National Bureau of Statistics of China",
          fetched_at: fetchedAt
        };
      })
      .filter((item) => item !== null);
  }

  static isBlockedPage(text: string): boolean {
    return /403 Forbidden|UrlACL|访问被阻断|WAF|Client IP|<html\b/iu.test(text);
  }

  private indicatorUrl(indicatorId: string): string {
    const dfwds = encodeURIComponent(JSON.stringify([{ wdcode: "zb", valuecode: indicatorId }]));
    return `${StatsGovMacroProvider.baseUrl}?m=QueryData&dbcode=hgnd&rowcode=sj&colcode=zb&wds=[]&dfwds=${dfwds}&k1=${Date.now()}`;
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
      referer: "https://data.stats.gov.cn/easyquery.htm?cn=C01",
      accept: "application/json,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9"
    };
  }

  private freshnessFor(date?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!date) return "unknown";
    const year = Number(date.slice(0, 4));
    if (!Number.isFinite(year)) return "unknown";
    const currentYear = new Date().getUTCFullYear();
    const ageYears = currentYear - year;
    if (ageYears <= 1) return "fresh";
    if (ageYears <= 2) return "acceptable";
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

  private static timeNodeNames(parsed: StatsGovResponse): Map<string, string> {
    const map = new Map<string, string>();
    for (const wdNode of parsed.returndata?.wdnodes ?? []) {
      if (wdNode.wdcode !== "sj") continue;
      for (const node of wdNode.nodes ?? []) {
        if (node.code) map.set(node.code, node.name ?? node.cname ?? node.code);
      }
    }
    return map;
  }

  private static numericValueFor(node: StatsGovNode): number {
    const value = node.data?.data ?? node.data?.strdata ?? node.value;
    return typeof value === "number" ? value : Number(value);
  }

  private static dateFor(node: StatsGovNode, timeNames: Map<string, string>): string | null {
    const timeCode = node.wds?.find((item) => item.wdcode === "sj")?.valuecode ?? node.code;
    const label = (timeCode ? timeNames.get(timeCode) : null) ?? timeCode ?? "";
    const yearMatch = /(20\d{2}|19\d{2})/u.exec(label);
    return yearMatch?.[1] ?? null;
  }

  private static indicatorIdFor(node: StatsGovNode): string | null {
    return node.wds?.find((item) => item.wdcode === "zb")?.valuecode ?? null;
  }
}
