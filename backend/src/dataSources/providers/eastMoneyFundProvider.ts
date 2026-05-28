import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

export class EastMoneyFundProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "eastmoney-fund",
      source_name: "EastMoney Fund Data Provider",
      source_type: "nav_history",
      trust_level: "B",
      enabled: true,
      priority: 10,
      access_method: "public web endpoint: https://fund.eastmoney.com/pingzhongdata/{fund_code}.js",
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
      freshness_policy: "current_nav should be same trading day; nav_history acceptable within 1 trading day",
      notes: "Fetches public Tiantian/EastMoney fund page JavaScript and parses fund meta, current NAV, NAV history, stage returns, and limited position codes."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const url = this.urlFor(input.fund_code);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
          referer: `https://fund.eastmoney.com/${input.fund_code}.html`
        }
      });
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, ["东方财富/天天基金公开页面返回非 2xx 状态。"], url);
      }

      const text = await response.text();
      const parsed = EastMoneyFundProvider.parsePingzhongData(text);
      if (!parsed.fund_code || !parsed.fund_name || !parsed.current_nav || !parsed.nav_history?.length) {
        return this.failure(info, "Missing core fields in EastMoney response", ["公开页面结构可能变化，核心字段解析失败。"], url);
      }

      const freshness = this.freshnessFor(parsed.last_nav_date);
      const warnings = [
        "数据来自公开页面解析，应遵守数据源服务条款并使用缓存/限速。",
        "该 provider 只能覆盖核心净值与部分页面字段，基金报告、完整持仓和政策证据仍需其他来源交叉验证。"
      ];
      if (freshness === "stale") warnings.push("最新净值日期可能过期，Argus 应降级结论。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: parsed,
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
        ["东方财富/天天基金公开数据抓取失败，Argus 应尝试备用 provider 或报告数据缺口。"],
        url
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  static parsePingzhongData(text: string): ProviderFundPayload & { last_nav_date?: string } {
    const fundCode = this.extractStringVar(text, "fS_code");
    const fundName = this.extractStringVar(text, "fS_name");
    const trend = this.extractJsonVar<Array<{ x: number; y: number; equityReturn?: number }>>(text, "Data_netWorthTrend") ?? [];
    const validTrend = trend.filter((item) => Number.isFinite(item.y));
    const navHistory = validTrend.map((item) => item.y);
    const latest = trend.at(-1);
    const navHistoryDates = validTrend.map((item) => (Number.isFinite(item.x) ? new Date(item.x).toISOString().slice(0, 10) : "unknown"));
    const stockCodes = this.extractStringArrayVar(text, "stockCodesNew") ?? this.extractStringArrayVar(text, "stockCodes") ?? [];
    const bondCodes = this.extractStringArrayVar(text, "zqCodes") ?? [];
    const stageReturns = this.extractStageReturns(text);
    return {
      fund_code: fundCode,
      fund_name: fundName,
      fund_type: this.inferFundType(fundName),
      current_nav: latest?.y,
      daily_return: latest?.equityReturn === undefined ? undefined : Number((latest.equityReturn / 100).toFixed(6)),
      nav_history: navHistory,
      nav_history_dates: navHistoryDates,
      stage_returns: stageReturns,
      portfolio_holdings: [...stockCodes.map((code) => `stock:${code}`), ...bondCodes.map((code) => `bond:${code}`)],
      themes: this.inferThemes(fundName),
      last_nav_date: latest?.x ? new Date(latest.x).toISOString().slice(0, 10) : undefined
    };
  }

  private urlFor(fundCode: string): string {
    return `https://fund.eastmoney.com/pingzhongdata/${fundCode}.js?v=${Date.now()}`;
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

  private freshnessFor(lastNavDate?: string): "fresh" | "acceptable" | "stale" | "unknown" {
    if (!lastNavDate) return "unknown";
    const ageMs = Date.now() - new Date(`${lastNavDate}T00:00:00.000Z`).getTime();
    const ageDays = ageMs / 86_400_000;
    if (ageDays <= 4) return "fresh";
    if (ageDays <= 10) return "acceptable";
    return "stale";
  }

  private static extractStringVar(text: string, varName: string): string | undefined {
    return new RegExp(`var\\s+${varName}\\s*=\\s*"([^"]*)"`, "u").exec(text)?.[1];
  }

  private static extractJsonVar<T>(text: string, varName: string): T | undefined {
    const marker = `var ${varName} =`;
    const start = text.indexOf(marker);
    if (start < 0) return undefined;
    const valueStart = text.indexOf("[", start) >= 0 && text.indexOf("[", start) < text.indexOf(";", start) ? text.indexOf("[", start) : text.indexOf("{", start);
    if (valueStart < 0) return undefined;
    const opening = text[valueStart];
    const closing = opening === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = valueStart; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        escaped = char === "\\" && !escaped;
        if (char === '"' && !escaped) inString = false;
        if (char !== "\\") escaped = false;
        continue;
      }
      if (char === '"') inString = true;
      if (char === opening) depth += 1;
      if (char === closing) depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(valueStart, i + 1)) as T;
      }
    }
    return undefined;
  }

  private static extractStringArrayVar(text: string, varName: string): string[] | undefined {
    const value = this.extractJsonVar<string[]>(text, varName);
    if (Array.isArray(value)) return value;
    const scalar = this.extractStringVar(text, varName);
    return scalar ? scalar.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
  }

  private static extractStageReturns(text: string): Record<string, number> {
    const mapping: Record<string, string> = {
      "1y": "syl_1n",
      "6m": "syl_6y",
      "3m": "syl_3y",
      "1m": "syl_1y"
    };
    return Object.fromEntries(
      Object.entries(mapping)
        .map(([key, varName]) => [key, this.extractStringVar(text, varName)] as const)
        .filter(([, raw]) => raw !== undefined && raw !== "")
        .map(([key, raw]) => [key, Number((Number(raw) / 100).toFixed(6))])
        .filter(([, value]) => Number.isFinite(value))
    );
  }

  private static inferFundType(name?: string): string {
    if (!name) return "unknown";
    if (name.includes("债")) return "bond";
    if (name.includes("指数") || name.includes("ETF")) return "index";
    if (name.includes("货币")) return "money_market";
    if (name.includes("QDII")) return "qdii";
    if (name.includes("混合")) return "mixed";
    if (name.includes("股票")) return "equity";
    return "unknown";
  }

  private static inferThemes(name?: string): string[] {
    if (!name) return [];
    const themes: string[] = [];
    if (name.includes("信用")) themes.push("信用债");
    if (name.includes("增强")) themes.push("增强策略");
    if (name.includes("科技")) themes.push("科技");
    if (name.includes("医药")) themes.push("医药");
    if (name.includes("消费")) themes.push("消费");
    if (name.includes("新能源")) themes.push("新能源");
    if (name.includes("红利")) themes.push("红利");
    return themes;
  }
}
