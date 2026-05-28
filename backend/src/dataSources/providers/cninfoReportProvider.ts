import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class CninfoReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "cninfo-report",
      source_name: "CNInfo Report Provider",
      source_type: "fund_report",
      trust_level: "A",
      enabled: true,
      priority: 25,
      access_method: "CNInfo disclosure adapter TODO",
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
      freshness_policy: "latest official disclosure preferred",
      notes: "Real provider adapter not implemented yet. Intended as backup official report source."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["holdings", "fund_reports"].includes(item));
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
      warnings: ["CNInfo 披露 provider 尚未实现。"],
      error: "Provider adapter TODO",
      is_demo: false
    };
  }
}
