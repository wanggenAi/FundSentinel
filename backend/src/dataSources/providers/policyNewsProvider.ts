import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class PolicyNewsProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "policy-news",
      source_name: "Policy and Industry News Provider",
      source_type: "policy",
      trust_level: "B",
      enabled: true,
      priority: 30,
      access_method: "official policy/news search adapter TODO",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      last_latency_ms: null,
      last_attempt_count: 0,
      cache_hit_count: 0,
      last_cache_hit_at: null,
      freshness_policy: "policy/news evidence should include source date and source trust level",
      notes: "Real provider adapter not implemented yet. Intended for policy evidence and industry news."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["policy_evidence", "industry_news", "social_sentiment"].includes(item));
  }

  async fetch(_input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
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
      warnings: ["政策与行业新闻 provider 尚未实现。"],
      error: "Provider adapter TODO",
      is_demo: false
    };
  }
}
