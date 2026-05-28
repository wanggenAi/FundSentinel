import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

type FetchLike = typeof fetch;

interface EastMoneyNavHistoryRow {
  FSRQ?: string;
  DWJZ?: string;
  LJJZ?: string;
  JZZZL?: string;
  SGZT?: string;
  SHZT?: string;
}

interface EastMoneyNavHistoryResponse {
  Data?: {
    LSJZList?: EastMoneyNavHistoryRow[];
    TotalCount?: number;
    PageSize?: number;
    PageIndex?: number;
  };
  ErrCode?: number;
  ErrMsg?: string | null;
}

export class EastMoneyNavHistoryProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = Number(process.env.FUNDSENTINEL_PROVIDER_TIMEOUT_MS ?? 8000),
    private readonly pageSize = Number(process.env.FUNDSENTINEL_EASTMONEY_NAV_PAGE_SIZE ?? 240)
  ) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "eastmoney-nav-history",
      source_name: "EastMoney Detailed NAV History Provider",
      source_type: "nav_history",
      trust_level: "B",
      enabled: true,
      priority: 11,
      access_method: "public F10 NAV endpoint: https://api.fund.eastmoney.com/f10/lsjz",
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
      freshness_policy: "detailed NAV rows should be fresh within 4 calendar days and acceptable within 10 calendar days",
      notes: "Fetches detailed public NAV rows from EastMoney/Tiantian F10 to cross-check the page JavaScript NAV provider. It is not an official fund company source."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["current_nav", "nav_history"].includes(item));
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
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: this.headers(input.fund_code) });
      if (!response.ok) {
        return this.failure(info, `HTTP ${response.status}`, ["东方财富/天天基金历史净值明细接口返回非 2xx 状态。"], url);
      }

      const parsed = EastMoneyNavHistoryProvider.parseNavHistoryResponse(await response.text(), input.fund_code);
      if (!parsed.nav_history?.length || parsed.current_nav === undefined) {
        return this.failure(info, "No usable NAV rows in EastMoney detailed NAV response", ["历史净值明细接口未返回可用净值行。"], url);
      }

      const latestDate = parsed.nav_history_dates?.at(-1);
      const freshness = this.freshnessFor(latestDate);
      const warnings = [
        "历史净值明细来自东方财富/天天基金公开接口，应遵守数据源服务条款并使用缓存/限速。",
        "该 provider 用于交叉校验核心 NAV；强结论仍需要基金公司/官方披露或授权数据源复核。"
      ];
      if (freshness === "stale") warnings.push("历史净值明细最新日期可能过期，Argus 应降级结论。");

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
        ["东方财富/天天基金历史净值明细抓取失败，Argus 应保留第二 NAV 来源缺口并继续尝试其他 provider。"],
        url
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  static parseNavHistoryResponse(text: string, fundCode: string): ProviderFundPayload {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as EastMoneyNavHistoryResponse;
    const rows = (parsed.Data?.LSJZList ?? [])
      .map((row) => ({
        date: row.FSRQ,
        nav: Number(row.DWJZ),
        dailyReturn: row.JZZZL === undefined || row.JZZZL === "" ? undefined : Number(row.JZZZL)
      }))
      .filter((row): row is { date: string; nav: number; dailyReturn: number | undefined } => Boolean(row.date) && Number.isFinite(row.nav) && row.nav > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows.at(-1);
    return {
      fund_code: fundCode,
      current_nav: latest?.nav,
      daily_return: latest?.dailyReturn === undefined ? undefined : Number((latest.dailyReturn / 100).toFixed(6)),
      nav_history: rows.map((row) => row.nav),
      nav_history_dates: rows.map((row) => row.date)
    };
  }

  private urlFor(fundCode: string): string {
    const params = new URLSearchParams({
      fundCode,
      pageIndex: "1",
      pageSize: String(this.pageSize),
      startDate: "",
      endDate: "",
      _: String(Date.now())
    });
    return `https://api.fund.eastmoney.com/f10/lsjz?${params.toString()}`;
  }

  private headers(fundCode: string): HeadersInit {
    return {
      "user-agent": "Mozilla/5.0 FundSentinel/0.1 (+https://github.com/wanggenAi/FundSentinel)",
      referer: `https://fundf10.eastmoney.com/jjjz_${fundCode}.html`,
      accept: "application/json,text/plain,*/*"
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
}
