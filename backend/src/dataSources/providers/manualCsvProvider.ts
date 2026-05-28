import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class ManualCsvProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "manual-csv-import",
      source_name: "Manual CSV Import Provider",
      source_type: "manual_import",
      trust_level: "C",
      enabled: false,
      priority: 40,
      access_method: "manual CSV upload TODO",
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
      freshness_policy: "CSV must include explicit date columns and user confirmation",
      notes: "Manual import is a real-data workaround, but upload parsing is not implemented in V0.1."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history", "holdings"].includes(item));
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
      warnings: ["手动 CSV 导入尚未实现，当前不能作为自动数据源使用。"],
      error: "Manual import not implemented",
      is_demo: false
    };
  }
}

