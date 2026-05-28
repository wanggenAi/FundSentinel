import { nowIso } from "../../schemas/index.js";
import { MockDataService } from "../../services/mockDataService.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class DemoFixtureProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(private readonly mockDataService = new MockDataService()) {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "demo-fixture",
      source_name: "Demo Fixture Provider",
      source_type: "demo_fixture",
      trust_level: "DEMO",
      enabled: true,
      priority: 999,
      access_method: "local fixture",
      requires_auth: false,
      is_demo: true,
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
      freshness_policy: "demo fixture has no market freshness guarantee",
      notes: "Only enabled when FUNDSENTINEL_DEMO_MODE=true. Never use as real business data."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.demo_mode;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!input.demo_mode) {
      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "unavailable",
        success: false,
        data: null,
        raw_reference: null,
        fetched_at: nowIso(),
        freshness: "unknown",
        warnings: ["Demo fixture disabled. Set FUNDSENTINEL_DEMO_MODE=true for local demo only."],
        error: "Demo mode disabled",
        is_demo: true
      };
    }
    const fixture = this.mockDataService.getFundDataPack(input.fund_code);
    return {
      source_id: info.source_id,
      source_name: info.source_name,
      source_type: info.source_type,
      trust_level: info.trust_level,
      data_status: "demo",
      success: true,
      data: {
        fund_code: fixture.fund_code,
        fund_name: fixture.fund_name,
        fund_type: fixture.fund_type,
        current_nav: fixture.current_nav,
        daily_return: fixture.daily_return,
        nav_history: fixture.nav_history,
        stage_returns: fixture.stage_returns,
        portfolio_holdings: fixture.portfolio_holdings,
        themes: fixture.themes,
        policy_signals: fixture.policy_signals,
        macro_indicators: fixture.macro_indicators,
        news_summaries: fixture.news_summaries,
        social_sentiment_score: fixture.social_sentiment_score
      },
      raw_reference: "backend fixture data",
      fetched_at: nowIso(),
      freshness: "unknown",
      warnings: ["这是 demo fixture 数据，不能用于真实投资判断。"],
      error: null,
      is_demo: true
    };
  }
}
