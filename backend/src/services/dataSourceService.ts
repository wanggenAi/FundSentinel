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
        failed_source_details: [],
        impact: "当前未发现数据缺口。",
        blocking_downstream_agents: [],
        recommended_solutions: [],
        created_by: "Argus",
        created_at: nowIso()
      }
    );
  }

  manualImportPlan(): {
    solutions: DataAcquisitionSolution[];
    required_csv_columns: string[];
    required_portfolio_json_fields: string[];
    required_report_manifest_fields: string[];
    report_manifest_filename: string;
    warnings: string[];
  } {
    return {
      required_csv_columns: ["fund_code", "date", "nav"],
      required_portfolio_json_fields: ["holdings[].fund_code", "holdings[].fund_name", "holdings[].holding_amount", "holdings[].cost_nav", "holdings[].current_nav"],
      required_report_manifest_fields: [
        "fund_code",
        "title",
        "announcement_id",
        "published_at",
        "document_kind",
        "source_name",
        "source_url",
        "pdf_path",
        "pdf_sha256"
      ],
      report_manifest_filename: "{fund_code}.reports.json",
      warnings: [
        "手动导入是真实数据 workaround，但必须记录来源、导入时间和用户确认。",
        "CSV 数据不得标记为自动抓取。",
        "官方报告 PDF manifest 不得标记为自动抓取，只能作为人工审核/运营导入的官方来源 fallback。",
        "V0.1 可通过 FUNDSENTINEL_MANUAL_CSV_DIR 指向本地审核目录，文件名为 {fund_code}.csv。",
        "V0.1 可通过 FUNDSENTINEL_MANUAL_REPORT_DIR 指向官方报告 PDF 审核目录，manifest 文件名为 {fund_code}.reports.json。",
        "V0.1 首页持仓可通过 FUNDSENTINEL_PORTFOLIO_FILE 指向用户确认的本地 JSON；未配置时生产接口返回空持仓降级状态，不回填 mock 资产。"
      ],
      solutions: [
        {
          problem: "首页智能缺少用户确认的真实持仓快照。",
          severity: "high",
          proposed_actions: [
            "把用户确认后的持仓快照写入 FUNDSENTINEL_PORTFOLIO_FILE 指向的 JSON 文件。",
            "每个 holding 至少包含 fund_code、fund_name、holding_amount、cost_nav、current_nav。",
            "可选提供 daily_pnl、unrealized_pnl_ratio、generated_at；导入后 PortfolioService 会计算权重和首页资产汇总。"
          ],
          engineering_tasks: [
            "实现后台手动持仓上传与校验 API。",
            "记录导入人、文件 SHA256、mtime、导入时间、用户确认声明和审计日志。",
            "增加持仓快照替换/撤回流程，并保持无券商、无银行、无支付账户连接。"
          ],
          manual_workaround: [
            "先由用户或运营维护本地 portfolio.json。",
            "仅保存基金代码、基金名称、金额和净值等快照字段，不接入交易、券商、银行、支付宝或账户授权。"
          ],
          owner_agent: "Argus"
        },
        {
          problem: "自动 provider 尚未获取真实基金核心数据。",
          severity: "high",
          proposed_actions: ["把审核后的历史净值 CSV 放入 FUNDSENTINEL_MANUAL_CSV_DIR。", "可选增加 fund_name、fund_type、daily_return、holding、theme 列。", "导入后由 Argus 校验日期、缺失值和异常净值。"],
          engineering_tasks: ["实现前端/后台 CSV 上传接口。", "增加文件 checksum、导入人、来源声明和审计日志。", "为 ManualCsvProvider 增加持久导入记录和回滚。"],
          manual_workaround: ["先由运营或用户提供经核验的 CSV 文件。", "文件名使用 {fund_code}.csv，例如 007951.csv。"],
          owner_agent: "Argus"
        },
        {
          problem: "自动 provider 已发现或需要补齐官方定期报告，但官网/证监会/巨潮自动校验可能被站点防护、覆盖范围或授权限制阻断。",
          severity: "high",
          proposed_actions: [
            "把审核后的官方 PDF 放入 FUNDSENTINEL_MANUAL_REPORT_DIR。",
            "为每只基金提供 {fund_code}.reports.json manifest，记录官方来源 URL、PDF 相对路径、发布日期、document_kind 和 SHA256。",
            "导入后由 Argus 校验 PDF 文件头和 SHA256；只有 periodic_report 且 pdf_verified=true 才补齐 official_fund_reports。"
          ],
          engineering_tasks: [
            "实现后台官方 PDF 上传与 manifest 生成接口。",
            "记录导入人、来源 URL、PDF SHA256、文件大小、导入时间和复核状态。",
            "为 ManualOfficialReportProvider 增加持久导入记录、撤回/替换流程和审计查询 API。"
          ],
          manual_workaround: [
            "先由运营从基金公司官网、证监会基金电子披露或巨潮资讯下载官方 PDF。",
            "计算 PDF SHA256 后写入 {fund_code}.reports.json，例如 007951.reports.json。",
            "manifest 中 document_kind 必须使用 periodic_report、report_notice、business_notice、sales_document 或 other。"
          ],
          owner_agent: "Argus"
        }
      ]
    };
  }
}
