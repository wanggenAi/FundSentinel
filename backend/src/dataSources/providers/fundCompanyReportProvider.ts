import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";

export class FundCompanyReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "fund-company-report",
      source_name: "Fund Company Report Provider",
      source_type: "fund_report",
      trust_level: "A",
      enabled: true,
      priority: 20,
      access_method: "fund company announcement crawler TODO",
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
      freshness_policy: "fund holdings/report data should match latest disclosed quarterly or annual report",
      notes: "Real provider adapter not implemented yet. Intended for holdings and fund report evidence."
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
      warnings: ["基金公司报告 provider 尚未实现，不能自动获取持仓或报告证据。"],
      error: "Provider adapter TODO",
      is_demo: false
    };
  }
}
