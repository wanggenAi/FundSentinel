import { nowIso } from "../../schemas/index.js";
import type { DataProvider } from "./baseProvider.js";
import type { DataProviderResult, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../sourceTypes.js";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

interface ManualCsvRow {
  fund_code: string;
  date: string;
  nav: number;
  fund_name?: string;
  fund_type?: string;
  daily_return?: number;
  holding?: string;
  theme?: string;
}

export class ManualCsvProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(private readonly dataDir = process.env.FUNDSENTINEL_MANUAL_CSV_DIR) {}

  sourceInfo(): DataSourceInfo {
    const enabled = Boolean(this.dataDir);
    return {
      source_id: "manual-csv-import",
      source_name: "Manual CSV Import Provider",
      source_type: "manual_import",
      trust_level: "B",
      enabled,
      priority: 40,
      access_method: "verified local CSV directory via FUNDSENTINEL_MANUAL_CSV_DIR",
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
      notes: "Manual import is a real-data workaround. CSV files must be operator/user verified and kept outside frontend assets."
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.some((item) => ["fund_meta", "current_nav", "nav_history", "holdings"].includes(item));
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    const info = this.sourceInfo();
    if (!this.dataDir) {
      return this.failure(info, "FUNDSENTINEL_MANUAL_CSV_DIR is not configured", ["手动 CSV 目录未配置，ManualCsvProvider 不参与业务数据获取。"]);
    }
    if (!/^\d{6}$/.test(input.fund_code)) {
      return this.failure(info, `Invalid fund code: ${input.fund_code}`, ["基金代码格式不符合 6 位数字。"]);
    }

    const filePath = path.join(this.dataDir, `${input.fund_code}.csv`);
    try {
      await access(filePath);
      const rows = ManualCsvProvider.parseCsv(await readFile(filePath, "utf8")).filter((row) => row.fund_code === input.fund_code);
      if (!rows.length) return this.failure(info, `No rows found for fund ${input.fund_code}`, ["CSV 文件存在，但没有匹配该基金代码的记录。"], filePath);

      const sortedRows = [...rows].sort((a, b) => a.date.localeCompare(b.date));
      const latest = sortedRows.at(-1)!;
      const navHistory = sortedRows.map((row) => row.nav);
      const warnings = [
        "手动 CSV 是经人工声明/导入的真实数据 workaround；Argus 必须展示来源路径和导入时间，不得标记为自动抓取。",
        "CSV 数据应保留导入人、来源说明和文件校验审计记录；V0.1 provider 仅完成读取与字段校验。"
      ];
      if (sortedRows.length < 30) warnings.push("CSV 净值历史少于 30 条，只能支持弱结论。");
      const freshness = this.freshnessFor(latest.date);
      if (freshness === "stale") warnings.push("CSV 最新净值日期较旧，后续 Agent 必须降级。");

      return {
        source_id: info.source_id,
        source_name: info.source_name,
        source_type: info.source_type,
        trust_level: info.trust_level,
        data_status: "partial",
        success: true,
        data: {
          fund_code: input.fund_code,
          fund_name: latest.fund_name,
          fund_type: latest.fund_type,
          current_nav: latest.nav,
          daily_return: latest.daily_return,
          nav_history: navHistory,
          portfolio_holdings: [...new Set(sortedRows.flatMap((row) => row.holding ? [row.holding] : []))],
          holdings_source: "manual_csv",
          themes: [...new Set(sortedRows.flatMap((row) => row.theme ? [row.theme] : []))]
        },
        raw_reference: filePath,
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
        ["手动 CSV 文件不可用或格式不合法；Argus 应继续保留自动数据源缺口，并提示人工导入校验方案。"],
        filePath
      );
    }
  }

  static parseCsv(csv: string): ManualCsvRow[] {
    const lines = csv
      .replace(/^\uFEFF/u, "")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0);
    if (lines.length < 2) throw new Error("CSV must include header and at least one data row.");

    const headers = this.splitCsvLine(lines[0]).map((header) => header.trim());
    const requiredHeaders = ["fund_code", "date", "nav"];
    const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
    if (missingHeaders.length) throw new Error(`CSV missing required columns: ${missingHeaders.join(", ")}`);

    return lines.slice(1).map((line, index) => {
      const cells = this.splitCsvLine(line);
      const record = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]?.trim() ?? ""]));
      const fundCode = record.fund_code;
      const date = record.date;
      const nav = Number(record.nav);
      if (!/^\d{6}$/.test(fundCode)) throw new Error(`CSV row ${index + 2} has invalid fund_code.`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`CSV row ${index + 2} has invalid date.`);
      if (!Number.isFinite(nav) || nav <= 0) throw new Error(`CSV row ${index + 2} has invalid nav.`);
      return {
        fund_code: fundCode,
        date,
        nav,
        fund_name: record.fund_name || undefined,
        fund_type: record.fund_type || undefined,
        daily_return: record.daily_return ? Number(record.daily_return) : undefined,
        holding: record.holding || undefined,
        theme: record.theme || undefined
      };
    });
  }

  private static splitCsvLine(line: string): string[] {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === "\"" && next === "\"") {
        current += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cells.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  }

  private freshnessFor(date: string): "fresh" | "acceptable" | "stale" | "unknown" {
    const timestamp = new Date(`${date}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(timestamp)) return "unknown";
    const ageDays = (Date.now() - timestamp) / 86_400_000;
    if (ageDays <= 7) return "fresh";
    if (ageDays <= 45) return "acceptable";
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
