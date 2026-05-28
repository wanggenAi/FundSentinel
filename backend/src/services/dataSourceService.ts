import { SourceRegistry } from "../dataSources/index.js";
import type { DataAcquisitionSolution, DataGapReport } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";
import { AIGateway } from "./aiGateway.js";
import { FundAnalysisService } from "./fundAnalysisService.js";

export class DataSourceService {
  constructor(
    private readonly sourceRegistry = new SourceRegistry(),
    private readonly fundAnalysisService = new FundAnalysisService(sourceRegistry, new AIGateway())
  ) {}

  listSources() {
    return {
      demo_mode: this.sourceRegistry.isDemoMode(),
      sources: this.sourceRegistry.listSources()
    };
  }

  catalog() {
    return {
      strategy: "real-data-first",
      note: "This catalog is Argus's source universe: authoritative and stable sources first, demo sources last.",
      sources: this.sourceRegistry.catalog()
    };
  }

  coverage() {
    return {
      strategy: "real-data-first",
      generated_at: nowIso(),
      note: "Coverage matrix shows whether Argus has implemented providers for each data requirement. Planned sources are not counted as integrated.",
      coverage: this.sourceRegistry.coverageMatrix()
    };
  }

  health() {
    return {
      demo_mode: this.sourceRegistry.isDemoMode(),
      generated_at: nowIso(),
      sources: this.sourceRegistry.health()
    };
  }

  async gaps(fundCode: string): Promise<DataGapReport> {
    const analysis = await this.fundAnalysisService.analyzeFund(fundCode, `data-gap-${fundCode}`);
    return (
      analysis.data_pack.data_gap_report ?? {
        fund_code: fundCode,
        missing_data: [],
        failed_sources: [],
        impact: "当前未发现数据缺口。",
        blocking_downstream_agents: [],
        recommended_solutions: [],
        created_by: "Argus",
        created_at: nowIso()
      }
    );
  }

  manualImportPlan(): { solutions: DataAcquisitionSolution[]; required_csv_columns: string[]; warnings: string[] } {
    return {
      required_csv_columns: ["fund_code", "date", "nav"],
      warnings: [
        "手动导入是真实数据 workaround，但必须记录来源、导入时间和用户确认。",
        "CSV 数据不得标记为自动抓取。",
        "V0.1 可通过 FUNDSENTINEL_MANUAL_CSV_DIR 指向本地审核目录，文件名为 {fund_code}.csv。"
      ],
      solutions: [
        {
          problem: "自动 provider 尚未获取真实基金核心数据。",
          severity: "high",
          proposed_actions: ["把审核后的历史净值 CSV 放入 FUNDSENTINEL_MANUAL_CSV_DIR。", "可选增加 fund_name、fund_type、daily_return、holding、theme 列。", "导入后由 Argus 校验日期、缺失值和异常净值。"],
          engineering_tasks: ["实现前端/后台 CSV 上传接口。", "增加文件 checksum、导入人、来源声明和审计日志。", "为 ManualCsvProvider 增加持久导入记录和回滚。"],
          manual_workaround: ["先由运营或用户提供经核验的 CSV 文件。", "文件名使用 {fund_code}.csv，例如 007951.csv。"],
          owner_agent: "Argus"
        }
      ]
    };
  }
}
