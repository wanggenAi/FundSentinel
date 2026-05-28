import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface GovCnPolicyItem {
  TITLE?: string;
  SUB_TITLE?: string;
  URL?: string;
  DOCRELPUBTIME?: string;
}

const THEME_KEYWORDS: Record<string, string[]> = {
  ai: ["人工智能", "算力", "数字", "数据", "互联网", "科技"],
  technology: ["科技", "数字", "数据", "人工智能", "算力", "信息"],
  semiconductor: ["集成电路", "半导体", "芯片", "制造"],
  new_energy: ["能源", "碳达峰", "碳中和", "新能源", "电力", "绿色"],
  medicine: ["医疗", "医药", "健康", "养老", "医保"],
  consumption: ["消费", "内需", "服务", "居民"],
  infrastructure: ["城市更新", "基础设施", "交通", "建设"],
  finance: ["金融", "资本市场", "债券", "基金", "投资"]
};

export class GovCnPolicyProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "gov-cn-policy",
      source_name: "Gov.cn Latest Policy Provider",
      source_type: "policy",
      trust_level: "A",
      enabled: true,
      priority: 28,
      access_method: "official JSON endpoint: https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      freshness_policy: "latest policy list should be fresh within 30 days and acceptable within 90 days",
      notes: "Fetches China government latest policy JSON and maps broad policy themes as official evidence only."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    const url = "https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: this.headers() });
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, [`国务院政策 JSON 返回 HTTP ${response.status}。`], url);
      }
      const text = await response.text();
      const items = GovCnPolicyProvider.parsePolicyList(text);
      if (!items.length) {
        return this.failure(info, "No policy items parsed from Gov.cn latest policy JSON", ["国务院政策 JSON 未返回可解析政策列表。"], url);
      }

      const matched = this.matchPolicyItems(items, input);
      const selected = matched.length ? matched : items.slice(0, 5);
      const latestDate = items.map((item) => item.DOCRELPUBTIME).filter(Boolean).sort().at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = ["国务院政策源为官方宏观政策证据，仅能支持 Logos 的政策背景，不代表单只基金投资结论。"];
      if (!matched.length) warnings.push("未能按基金代码直接匹配主题，返回最新政策作为宏观政策背景，Logos 必须弱化主题相关性。");
      if (freshness === "stale") warnings.push("国务院政策列表最新日期偏旧，政策证据应降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: matched.length ? "partial" : "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          policy_signals: selected.map((item) => `${item.DOCRELPUBTIME ?? "unknown-date"} ${item.TITLE ?? "未命名政策"}`),
          news_summaries: selected.map((item) => `官方政策：${item.TITLE ?? "未命名政策"}（${item.DOCRELPUBTIME ?? "日期未知"}）`)
        },
        raw_reference: url,
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
        ["国务院政策 JSON 抓取失败，Argus 应保留 policy_evidence 缺口并尝试其他官方政策 provider。"],
        url
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  static parsePolicyList(text: string): GovCnPolicyItem[] {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as GovCnPolicyItem[];
    return Array.isArray(parsed) ? parsed.filter((item) => item.TITLE && item.URL) : [];
  }

  private matchPolicyItems(items: GovCnPolicyItem[], input: FundDataSourceInput): GovCnPolicyItem[] {
    const keywords = this.keywordsForInput(input);
    return items
      .filter((item) => keywords.some((keyword) => `${item.TITLE ?? ""}${item.SUB_TITLE ?? ""}`.includes(keyword)))
      .slice(0, 8);
  }

  private keywordsForInput(input: FundDataSourceInput): string[] {
    const configured = process.env[`FUNDSENTINEL_POLICY_KEYWORDS_${input.fund_code}`];
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
      if (theme === "consumption" && /白酒|消费|食品|饮料/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "medicine" && /医药|医疗|创新药|器械/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
      if (theme === "new_energy" && /新能源|光伏|储能|电池|电力|绿色/u.test(contextText)) {
        for (const keyword of themeKeywords) keywords.add(keyword);
      }
    }
    return [...keywords];
  }

  private headers(): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: "https://www.gov.cn/zhengce/zuixin/"
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
    if (ageDays <= 30) return "fresh";
    if (ageDays <= 90) return "acceptable";
    return "stale";
  }
}
