import { BaseAgent } from "./base.js";
import { SourceRegistry, type DataProviderResult, type ProviderFundPayload } from "../dataSources/index.js";
import type {
  AgentResult,
  DataAcquisitionPlan,
  DataAcquisitionSolution,
  DataGapReport,
  DataQualityReport,
  DataRequirement,
  DataStatus,
  EvidenceItem,
  FundDataPack
} from "../schemas/index.js";
import { type AgentStatus, nowIso } from "../schemas/index.js";
import { AIGateway } from "../services/aiGateway.js";

export class ArgusAgent extends BaseAgent {
  readonly name = "Argus";
  readonly role = "Data Steward Agent";
  readonly responsibilities = [
    "优先获取真实基金数据并记录来源",
    "校验基金元数据、当前净值、历史净值、持仓、报告和外部证据",
    "在数据不足时输出 DataGapReport 和 DataAcquisitionSolution，阻止假数据驱动强结论"
  ];

  constructor(
    private readonly sourceRegistry = new SourceRegistry(),
    aiGateway?: AIGateway
  ) {
    super(aiGateway);
  }

  async prepareDataPack(taskId: string, fundCode: string): Promise<{ dataPack: FundDataPack; result: AgentResult }> {
    const plan = this.buildAcquisitionPlan(taskId, fundCode);
    const providerResults = await this.sourceRegistry.fetchAll({
      fund_code: fundCode,
      required_data: [...plan.required_data, ...plan.optional_data],
      demo_mode: this.sourceRegistry.isDemoMode()
    });
    const dataPack = this.buildFundDataPack(fundCode, plan, providerResults);
    const quality = dataPack.data_quality_report;
    const status: AgentStatus = quality.data_status === "ready" ? "success" : quality.allow_downstream_analysis ? "warning" : "failed";
    const evidence = this.buildEvidence(providerResults);
    const confidence = this.confidenceFor(quality.data_status, quality.score);
    const isMock = this.isMockQuality(quality);

    return {
      dataPack,
      result: this.buildResult({
        taskId,
        fundCode: dataPack.fund_code,
        status,
        score: quality.score,
        confidence,
        summary: this.summaryFor(dataPack),
        evidence,
        metrics: {
          data_status: quality.data_status,
          data_quality_score: quality.score,
          real_source_count: quality.real_source_count,
          demo_source_count: quality.demo_source_count,
          authoritative_source_count: quality.authoritative_source_count,
          aggregator_source_count: quality.aggregator_source_count,
          manual_source_count: quality.manual_source_count,
          macro_source_count: quality.macro_source_count,
          successful_source_count: quality.successful_source_count,
          failed_source_count: quality.failed_source_count,
          source_composition: quality.source_composition,
          missing_core_fields: quality.missing_core_fields,
          missing_auxiliary_fields: quality.missing_auxiliary_fields,
          allow_downstream_analysis: quality.allow_downstream_analysis,
          allow_strong_conclusion: quality.allow_strong_conclusion,
          nav_points: dataPack.nav_history.length,
          theme_count: dataPack.themes.length
        },
        warnings: [...quality.warnings, ...quality.blocking_issues],
        nextSuggestions: dataPack.acquisition_solutions.flatMap((solution) => solution.proposed_actions),
        isMock
      })
    };
  }

  async run(taskId: string, fundCode: string): Promise<AgentResult> {
    return (await this.prepareDataPack(taskId, fundCode)).result;
  }

  buildAcquisitionPlan(taskId: string, fundCode: string): DataAcquisitionPlan {
    return {
      task_id: taskId,
      fund_code: fundCode,
      requested_by: "Atlas",
      required_data: ["fund_meta", "current_nav", "nav_history"],
      optional_data: ["holdings", "fund_reports", "policy_evidence", "macro_data", "industry_news", "social_sentiment"],
      provider_candidates: this.sourceRegistry.providerCandidates(),
      acquisition_strategy: "优先使用真实 provider 获取基金元数据、当前净值和历史净值；再补充持仓、报告、政策和新闻证据。",
      fallback_strategy: "主数据源失败后尝试备用真实 provider；自动源全部失败时提出 CSV/第三方 API/定时同步等解决方案。Demo fixture 仅在显式 demo mode 下启用。",
      created_by: "Argus",
      created_at: nowIso()
    };
  }

  private buildFundDataPack(
    fundCode: string,
    plan: DataAcquisitionPlan,
    providerResults: Array<DataProviderResult<ProviderFundPayload>>
  ): FundDataPack {
    const merged = this.mergeProviderPayloads(providerResults.filter((result) => result.success && result.data).map((result) => result.data!));
    const quality = this.buildQualityReport(providerResults, merged);
    const gapReport = this.buildGapReport(fundCode, quality, providerResults);
    const solutions = this.buildSolutions(quality, gapReport);
    const isMock = this.isMockQuality(quality);
    const now = nowIso();
    return {
      fund_code: merged.fund_code ?? fundCode,
      fund_name: merged.fund_name ?? "Unknown fund",
      fund_type: merged.fund_type ?? "unknown",
      themes: merged.themes ?? [],
      current_nav: merged.current_nav ?? 0,
      daily_return: merged.daily_return ?? 0,
      nav_history: merged.nav_history ?? [],
      nav_history_dates: merged.nav_history_dates ?? [],
      stage_returns: merged.stage_returns ?? {},
      portfolio_holdings: merged.portfolio_holdings ?? [],
      fund_report_refs: merged.fund_report_refs ?? [],
      fund_report_documents: merged.fund_report_documents ?? [],
      policy_signals: merged.policy_signals ?? [],
      macro_indicators: merged.macro_indicators ?? [],
      news_summaries: merged.news_summaries ?? [],
      social_sentiment_score: merged.social_sentiment_score ?? 0,
      evidence_items: this.buildEvidence(providerResults),
      data_sources: providerResults.map((result) => ({
        source_id: result.source_id,
        source_name: result.source_name,
        source_type: result.source_type,
        trust_level: result.trust_level,
        success: result.success,
        data_status: result.data_status,
        freshness: result.freshness,
        fetched_at: result.fetched_at,
        raw_reference: result.raw_reference,
        record_count: this.recordCountFor(result.data),
        as_of: result.data?.holdings_as_of,
        is_demo: result.is_demo,
        error: result.error,
        warnings: result.warnings,
        attempt_count: result.attempt_count ?? 1,
        latency_ms: result.latency_ms ?? null,
        cache_hit: result.cache_hit ?? false,
        cache_expires_at: result.cache_expires_at ?? null,
        skipped_by_circuit_breaker: result.skipped_by_circuit_breaker ?? false,
        circuit_open_until: this.sourceRegistry.listSources().find((source) => source.source_id === result.source_id)?.circuit_open_until ?? null,
        manual_import_audit: result.data?.manual_import_audit ?? null,
        manual_report_import_audit: result.data?.manual_report_import_audit ?? null
      })),
      data_acquisition_plan: plan,
      data_quality_report: quality,
      data_gap_report: gapReport,
      acquisition_solutions: solutions,
      data_status: quality.data_status,
      allow_downstream_analysis: quality.allow_downstream_analysis,
      allow_strong_conclusion: quality.allow_strong_conclusion,
      data_quality: {
        level: quality.level,
        score: quality.score / 100,
        source: "Argus SourceRegistry",
        updated_at: quality.generated_at,
        warnings: quality.warnings,
        is_mock: isMock
      },
      updated_at: now,
      generated_at: now,
      is_mock: isMock
    };
  }

  private isMockQuality(quality: DataQualityReport): boolean {
    return quality.data_status === "demo" || quality.demo_source_count > 0;
  }

  private mergeProviderPayloads(payloads: ProviderFundPayload[]): ProviderFundPayload {
    const merged: ProviderFundPayload = {};
    for (const payload of payloads) {
      this.setIfMissing(merged, "fund_code", payload.fund_code);
      this.setIfMissing(merged, "fund_name", payload.fund_name);
      this.setIfMissing(merged, "fund_type", payload.fund_type);
      this.setIfMissing(merged, "current_nav", payload.current_nav);
      this.setIfMissing(merged, "daily_return", payload.daily_return);
      this.setIfMissing(merged, "social_sentiment_score", payload.social_sentiment_score);

      if (this.shouldUseNavHistory(payload, merged)) {
        merged.nav_history = payload.nav_history;
        merged.nav_history_dates = payload.nav_history_dates;
        if (payload.current_nav !== undefined) merged.current_nav = payload.current_nav;
        if (payload.daily_return !== undefined) merged.daily_return = payload.daily_return;
      }
      if (payload.stage_returns) {
        merged.stage_returns = { ...(merged.stage_returns ?? {}), ...payload.stage_returns };
      }
      merged.portfolio_holdings = this.mergeUnique(merged.portfolio_holdings, payload.portfolio_holdings);
      merged.fund_report_refs = this.mergeUnique(merged.fund_report_refs, payload.fund_report_refs);
      merged.fund_report_documents = this.mergeReportDocuments(merged.fund_report_documents, payload.fund_report_documents);
      merged.themes = this.mergeUnique(merged.themes, payload.themes);
      merged.policy_signals = this.mergeUnique(merged.policy_signals, payload.policy_signals);
      merged.macro_indicators = this.mergeMacroIndicators(merged.macro_indicators, payload.macro_indicators);
      merged.news_summaries = this.mergeUnique(merged.news_summaries, payload.news_summaries);

      if (payload.holdings_as_of && (!merged.holdings_as_of || payload.holdings_as_of > merged.holdings_as_of)) {
        merged.holdings_as_of = payload.holdings_as_of;
      }
      this.setIfMissing(merged, "holdings_source", payload.holdings_source);
    }
    return merged;
  }

  private buildQualityReport(
    providerResults: Array<DataProviderResult<ProviderFundPayload>>,
    merged: ProviderFundPayload
  ): DataQualityReport {
    const successful = providerResults.filter((result) => result.success);
    const failed = providerResults.filter((result) => !result.success);
    const demoSuccess = successful.filter((result) => result.is_demo);
    const realSuccess = successful.filter((result) => !result.is_demo);
    const sourceComposition = this.buildSourceComposition(successful, failed);
    const missingCoreFields = [
      !merged.fund_code || !merged.fund_name ? "fund_meta" : null,
      merged.current_nav === undefined ? "current_nav" : null,
      !merged.nav_history?.length ? "nav_history" : null
    ].filter(Boolean) as string[];
    const hasFundReportSource = successful.some((result) => result.source_type === "fund_report" || Boolean(result.data?.fund_report_refs?.length));
    const hasAuthoritativeFundReportSource = this.hasAuthoritativeFundReportDocument(successful);
    const navConsistencyReport = this.buildNavConsistencyReport(successful);
    const missingAuxiliaryFields = [
      !merged.portfolio_holdings?.length ? "holdings" : null,
      sourceComposition.official_core_coverage.current_nav ? null : "official_current_nav",
      sourceComposition.official_core_coverage.nav_history ? null : "official_nav_history",
      hasFundReportSource ? null : "fund_reports",
      hasAuthoritativeFundReportSource ? null : "official_fund_reports",
      !merged.policy_signals?.length ? "policy_evidence" : null,
      !merged.macro_indicators?.length ? "macro_data" : null,
      !merged.news_summaries?.length ? "industry_news" : null,
      merged.social_sentiment_score === undefined ? "social_sentiment" : null
    ].filter(Boolean) as string[];
    const staleSources = providerResults.filter((result) => result.freshness === "stale").map((result) => result.source_name);
    const warnings = providerResults.flatMap((result) => result.warnings);
    const blockingIssues: string[] = [];
    let dataStatus: DataStatus = "ready";
    let allowDownstreamAnalysis = true;
    let allowStrongConclusion = true;

    if (demoSuccess.length > 0 && realSuccess.length === 0) {
      dataStatus = "demo";
      allowStrongConclusion = false;
    } else if (demoSuccess.length > 0) {
      dataStatus = "demo";
      allowStrongConclusion = false;
      warnings.push("显式 demo fixture 已参与数据合并；整包仅可作为 mock/demo 输出，不能标记为真实业务分析。");
    } else if (successful.length === 0) {
      dataStatus = "unavailable";
      allowDownstreamAnalysis = false;
      allowStrongConclusion = false;
      blockingIssues.push("没有可用真实数据源，不能继续真实基金分析。");
    } else if (missingCoreFields.length > 0) {
      dataStatus = "insufficient";
      allowDownstreamAnalysis = false;
      allowStrongConclusion = false;
      blockingIssues.push(`核心数据缺失：${missingCoreFields.join(", ")}。`);
    } else if (
      missingAuxiliaryFields.some((field) =>
        ["holdings", "official_current_nav", "official_nav_history", "fund_reports", "official_fund_reports", "policy_evidence"].includes(field)
      )
    ) {
      dataStatus = "partial";
      allowStrongConclusion = false;
      warnings.push(`辅助证据不完整：${missingAuxiliaryFields.join(", ")}。Logos 必须降级，Atlas 不允许强结论。`);
    }

    if (staleSources.length > 0) {
      allowStrongConclusion = false;
      warnings.push(`存在过期数据源：${staleSources.join(", ")}。`);
      if (dataStatus === "ready") dataStatus = "partial";
    }
    if (navConsistencyReport.status === "conflict") {
      dataStatus = dataStatus === "ready" ? "partial" : dataStatus;
      allowStrongConclusion = false;
      warnings.push(`核心净值跨源校验冲突：${navConsistencyReport.conflicts.join("；")}。`);
    }
    if (missingAuxiliaryFields.includes("industry_news")) warnings.push("industry_news 缺失，不影响核心数据但会降低解释完整性。");
    if (missingAuxiliaryFields.includes("macro_data")) warnings.push("macro_data 缺失，不影响基金核心净值分析，但会降低跨市场/宏观解释能力。");
    if (missingAuxiliaryFields.includes("social_sentiment")) warnings.push("social_sentiment 缺失，不影响核心分析，只能作为弱可选信号。");
    if (missingAuxiliaryFields.includes("official_fund_reports")) {
      warnings.push(...this.officialReportGapWarnings(successful));
    }

    const score = this.scoreFor(
      dataStatus,
      missingCoreFields.length,
      realSuccess.length,
      demoSuccess.length,
      failed.length,
      navConsistencyReport.status === "conflict"
    );
    return {
      data_status: dataStatus,
      level: score >= 75 ? "high" : score >= 45 ? "medium" : "low",
      score,
      real_source_count: realSuccess.length,
      demo_source_count: demoSuccess.length,
      authoritative_source_count: sourceComposition.authoritative.length,
      aggregator_source_count: sourceComposition.aggregator.length,
      manual_source_count: sourceComposition.manual.length,
      macro_source_count: sourceComposition.macro.length,
      successful_source_count: successful.length,
      failed_source_count: failed.length,
      source_composition: sourceComposition,
      missing_core_fields: missingCoreFields,
      missing_auxiliary_fields:
        navConsistencyReport.status === "conflict" ? [...new Set([...missingAuxiliaryFields, "nav_consistency"])] : missingAuxiliaryFields,
      stale_sources: staleSources,
      warnings,
      blocking_issues: blockingIssues,
      nav_consistency_report: navConsistencyReport,
      allow_downstream_analysis: allowDownstreamAnalysis,
      allow_strong_conclusion: allowStrongConclusion,
      generated_by: "Argus",
      generated_at: nowIso()
    };
  }

  private buildGapReport(
    fundCode: string,
    quality: DataQualityReport,
    providerResults: Array<DataProviderResult<ProviderFundPayload>>
  ): DataGapReport | null {
    const failedResults = providerResults.filter((result) => !result.success);
    const failedSources = failedResults.map((result) => result.source_name);
    const failedSourceDetails = failedResults.map((result) => ({
      source_id: result.source_id,
      source_name: result.source_name,
      source_type: result.source_type,
      trust_level: result.trust_level,
      data_status: result.data_status,
      freshness: result.freshness,
      fetched_at: result.fetched_at,
      raw_reference: result.raw_reference,
      error: result.error,
      warnings: result.warnings,
      attempt_count: result.attempt_count ?? 1,
      latency_ms: result.latency_ms ?? null,
      cache_hit: result.cache_hit ?? false,
      skipped_by_circuit_breaker: result.skipped_by_circuit_breaker ?? false
    }));
    const missingData = [...new Set([...quality.missing_core_fields, ...quality.missing_auxiliary_fields])];
    const providerFailureSolutions = failedSourceDetails.length
      ? [
          "排查失败 provider 的错误、attempt_count、latency_ms 与 circuit-breaker 状态；失败源不得被标记为覆盖成功。",
          "若失败源属于官方披露、基金公司或授权数据源，补充 parser/timeout 回归测试，并保留 DataGapReport 直到可重新获取且记录 provenance。",
          "对持续失败的数据源启用备用官方/授权 provider 或人工审计导入 workaround，不得静默回退到 demo/fixture 数据。"
        ]
      : [];
    const reportGapSolutions = quality.missing_auxiliary_fields.includes("official_fund_reports")
      ? [
          "official_fund_reports 缺口要求官方披露定期报告 PDF 通过元数据校验；只有提示性公告、聚合索引或未校验 PDF 不能放行强结论。",
          "对已解析到的官方 PDF 执行 HEAD 校验并记录 content-type/content-length；校验失败时保留 DataGapReport，不得把链接当作完整报告证据。",
          "若官网/证监会站点防护阻断自动校验，改用运营导入官方 PDF 或授权披露 API，并保留导入审计记录。"
        ]
      : [];
    if (quality.data_status === "ready" && failedSourceDetails.length === 0) return null;
    const dataGapSolutions =
      quality.data_status === "ready"
        ? []
        : [
            ...(quality.missing_auxiliary_fields.includes("official_current_nav")
              ? ["接入基金公司官网、监管披露或授权数据 API 的官方当前净值 provider，补齐 official_current_nav。"]
              : []),
            ...(quality.missing_auxiliary_fields.includes("official_nav_history")
              ? ["接入基金公司官网、监管披露或授权数据 API 的官方历史净值 provider，补齐 official_nav_history。"]
              : []),
            ...reportGapSolutions,
            "接入基金公司官网公告/定期报告 provider，补齐官方 fund_reports。",
            "接入官方政策与行业数据 provider，补齐 policy_evidence。",
            "为已实现的真实 provider 增加缓存、限流、重试和第二来源交叉校验。",
            "实现证监会基金电子披露查询 endpoint 或官方 PDF 导入归档，补齐 official_fund_reports。",
            "支持用户或运营手动导入历史净值/持仓 CSV，并保留审计记录。",
            "增加定时同步任务。",
            "增加数据源监控告警。"
          ];
    const downstreamBlockingAgents =
      quality.data_status === "ready" ? [] : quality.allow_downstream_analysis ? ["Logos"] : ["Logos", "Nadir", "Vega", "Aegis"];
    return {
      fund_code: fundCode,
      missing_data: missingData,
      failed_sources: failedSources,
      failed_source_details: failedSourceDetails,
      impact:
        quality.data_status === "ready"
          ? "核心数据已满足当前分析，但仍有 provider 获取失败；失败源必须审计、监控并在恢复前不得计作覆盖成功。"
          : quality.allow_downstream_analysis
            ? "只能支持弱结论，后续 Agent 必须降级。"
            : "不能支持真实基金分析，后续 Agent 不应输出复核结论。",
      blocking_downstream_agents: downstreamBlockingAgents,
      recommended_solutions: [
        ...providerFailureSolutions,
        ...dataGapSolutions
      ],
      created_by: "Argus",
      created_at: nowIso()
    };
  }

  private buildSolutions(quality: DataQualityReport, gapReport: DataGapReport | null): DataAcquisitionSolution[] {
    if (!gapReport) return [];
    if (quality.data_status === "ready" && gapReport.failed_source_details.length > 0) {
      const optionalMissing = gapReport.missing_data.length ? `；非阻断缺口：${gapReport.missing_data.join(", ")}` : "";
      return [
        {
          problem: `核心数据状态为 ready，但以下 provider 获取失败：${gapReport.failed_sources.join(", ")}${optionalMissing}。`,
          severity: "medium",
          proposed_actions: [
            "保留失败详情供审核，不得把失败 provider 计作成功覆盖。",
            "检查 SourceRegistry 健康状态、重试次数、延迟和 circuit-breaker 状态。",
            "优先修复官方/授权 provider，或配置等价备用真实来源进行交叉验证。"
          ],
          engineering_tasks: [
            "为失败 provider 增加错误场景 parser/timeout 回归测试。",
            "把持续失败的官方/授权数据源纳入监控告警和 cooldown 观察。",
            "确认失败恢复前不会用 demo/fixture 数据替代真实业务输出。"
          ],
          manual_workaround: [
            "如失败源阻断官方报告或核心验证，可用人工审计导入补齐，并保留 checksum、mtime、导入时间和来源 URL。",
            "人工导入只能作为明确 fallback，不得标记为自动 provider 成功。"
          ],
          owner_agent: "Argus"
        }
      ];
    }
    return [
      {
        problem: `当前数据状态为 ${quality.data_status}，缺少 ${gapReport.missing_data.join(", ")}。`,
        severity: quality.allow_downstream_analysis ? "high" : "blocking",
        proposed_actions: [
          "优先补齐 official_current_nav 和 official_nav_history，避免聚合净值驱动强结论。",
          "优先接入基金公司官网、证监会披露、巨潮资讯等官方报告 provider。",
          "接入官方政策和行业数据 provider，为 Logos 提供可追溯硬证据。",
          "实现 ManualCsvProvider 作为短期真实数据导入和交叉验证方案。",
          "在真实数据可用前，禁止对用户展示为真实自动分析。"
        ],
        engineering_tasks: [
          "为头部基金公司实现官方当前净值/历史净值 provider，并将结果纳入 official_core_coverage。",
          "为 EastMoneyFundProvider、EastMoneyFundArchiveProvider 和 CsrcFundDisclosureProvider 增加持久缓存、限流和失败重试。",
          "完成证监会基金电子披露官方报告检索 endpoint 适配，若站点防护阻断则改走官方 PDF 人工导入和授权数据 API。",
          "实现基金公司公告/巨潮资讯报告检索、下载、解析和来源归档。",
          "实现政策网站检索、主题映射和证据去重。",
          "实现 CSV schema 校验和人工导入审计记录。",
          "为 SourceRegistry 增加数据源健康监控。"
        ],
        manual_workaround: [
          "短期可通过 CSV 导入基金元数据、当前净值和历史净值完成验证。",
          "人工导入结果必须显示来源和导入时间，不能标记为自动真实抓取。"
        ],
        owner_agent: "Argus"
      }
    ];
  }

  private setIfMissing<K extends keyof ProviderFundPayload>(target: ProviderFundPayload, key: K, value: ProviderFundPayload[K]): void {
    if (target[key] === undefined && value !== undefined && value !== null) {
      target[key] = value;
    }
  }

  private mergeUnique(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
    if (!left?.length && !right?.length) return left ?? right;
    return [...new Set([...(left ?? []), ...(right ?? [])])];
  }

  private shouldUseNavHistory(candidate: ProviderFundPayload, current: ProviderFundPayload): boolean {
    if (!candidate.nav_history?.length) return false;
    if (!current.nav_history?.length) return true;
    const candidateLatest = candidate.nav_history_dates?.at(-1);
    const currentLatest = current.nav_history_dates?.at(-1);
    if (candidateLatest && currentLatest && candidateLatest !== currentLatest) return candidateLatest > currentLatest;
    if (candidateLatest && !currentLatest) return true;
    if (!candidateLatest && currentLatest) return false;
    return candidate.nav_history.length > current.nav_history.length;
  }

  private buildNavConsistencyReport(results: Array<DataProviderResult<ProviderFundPayload>>): DataQualityReport["nav_consistency_report"] {
    const comparedSources = results
      .filter((result) => !result.is_demo && (result.data?.current_nav !== undefined || result.data?.nav_history?.length))
      .map((result) => ({
        source_id: result.source_id,
        source_name: result.source_name,
        current_nav: result.data?.current_nav ?? null,
        latest_date: result.data?.nav_history_dates?.at(-1) ?? null,
        nav_points: result.data?.nav_history?.length ?? 0
      }));

    const navSources = comparedSources.filter((source) => source.current_nav !== null);
    const latestDate = this.latestDateFor(comparedSources.map((source) => source.latest_date));
    const comparableNavSources = latestDate ? navSources.filter((source) => source.latest_date === latestDate) : [];
    if (!latestDate || comparableNavSources.length < 2) {
      const notCheckedReasons = this.navConsistencyNotCheckedReasons(comparedSources, navSources, comparableNavSources, latestDate);
      return {
        checked_source_count: comparedSources.length,
        max_current_nav_delta: null,
        max_current_nav_delta_ratio: null,
        latest_nav_date: latestDate,
        compared_sources: comparedSources,
        not_checked_reasons: notCheckedReasons,
        conflicts: [],
        status: "not_checked"
      };
    }

    let maxDelta = 0;
    let maxDeltaRatio = 0;
    const conflicts: string[] = [];
    for (let leftIndex = 0; leftIndex < comparableNavSources.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < comparableNavSources.length; rightIndex += 1) {
        const left = comparableNavSources[leftIndex]!;
        const right = comparableNavSources[rightIndex]!;
        const delta = Math.abs((left.current_nav ?? 0) - (right.current_nav ?? 0));
        const baseline = Math.max(Math.abs(left.current_nav ?? 0), Math.abs(right.current_nav ?? 0), 1);
        const ratio = delta / baseline;
        maxDelta = Math.max(maxDelta, delta);
        maxDeltaRatio = Math.max(maxDeltaRatio, ratio);
        if (delta > 0.002 && ratio > 0.001) {
          conflicts.push(`${left.source_id} current_nav=${left.current_nav} 与 ${right.source_id} current_nav=${right.current_nav} 偏差 ${delta.toFixed(6)} (${(ratio * 100).toFixed(3)}%)`);
        }
      }
    }

    return {
      checked_source_count: comparedSources.length,
      max_current_nav_delta: Number(maxDelta.toFixed(6)),
      max_current_nav_delta_ratio: Number(maxDeltaRatio.toFixed(6)),
      latest_nav_date: latestDate,
      compared_sources: comparedSources,
      not_checked_reasons: [],
      conflicts,
      status: conflicts.length ? "conflict" : "consistent"
    };
  }

  private navConsistencyNotCheckedReasons(
    comparedSources: Array<{ current_nav: number | null; latest_date: string | null }>,
    navSources: Array<{ current_nav: number | null; latest_date: string | null }>,
    comparableNavSources: Array<{ current_nav: number | null; latest_date: string | null }>,
    latestDate: string | null
  ): string[] {
    const reasons: string[] = [];
    if (!comparedSources.length) reasons.push("no_real_nav_sources");
    if (comparedSources.length && navSources.length < 2) reasons.push("fewer_than_two_current_nav_sources");
    if (navSources.some((source) => !source.latest_date)) reasons.push("missing_nav_dates_for_cross_source_check");
    if (navSources.length >= 2 && latestDate && comparableNavSources.length < 2) reasons.push("fewer_than_two_same_date_nav_sources");
    return [...new Set(reasons)];
  }

  private buildSourceComposition(
    successful: Array<DataProviderResult<ProviderFundPayload>>,
    failed: Array<DataProviderResult<ProviderFundPayload>>
  ): DataQualityReport["source_composition"] {
    const authoritative = successful
      .filter((result) => this.isAuthoritative(result))
      .map((result) => result.source_id);
    const aggregator = successful
      .filter((result) => !result.is_demo && ["nav_history", "holdings", "fund_report"].includes(result.source_type) && result.trust_level !== "A")
      .map((result) => result.source_id);
    const manual = successful.filter((result) => result.source_type === "manual_import").map((result) => result.source_id);
    const macro = successful.filter((result) => result.source_type === "macro_data").map((result) => result.source_id);
    const demo = successful.filter((result) => result.is_demo).map((result) => result.source_id);

    return {
      authoritative: [...new Set(authoritative)],
      aggregator: [...new Set(aggregator)],
      manual: [...new Set(manual)],
      macro: [...new Set(macro)],
      demo: [...new Set(demo)],
      failed: [...new Set(failed.map((result) => result.source_id))],
      official_core_coverage: {
        fund_meta: this.hasAuthoritativeField(successful, "fund_code") || this.hasAuthoritativeField(successful, "fund_name"),
        current_nav: this.hasAuthoritativeField(successful, "current_nav"),
        nav_history: successful.some((result) => this.isAuthoritative(result) && Boolean(result.data?.nav_history?.length)),
        holdings: successful.some((result) => this.isAuthoritative(result) && Boolean(result.data?.portfolio_holdings?.length)),
        fund_reports: this.hasAuthoritativeFundReportDocument(successful)
      }
    };
  }

  private mergeReportDocuments(
    left: ProviderFundPayload["fund_report_documents"] | undefined,
    right: ProviderFundPayload["fund_report_documents"] | undefined
  ): ProviderFundPayload["fund_report_documents"] | undefined {
    if (!left?.length && !right?.length) return left ?? right;
    const merged = new Map<string, NonNullable<ProviderFundPayload["fund_report_documents"]>[number]>();
    for (const document of [...(left ?? []), ...(right ?? [])]) {
      merged.set(document.announcement_id || document.title, document);
    }
    return [...merged.values()];
  }

  private mergeMacroIndicators(
    left: ProviderFundPayload["macro_indicators"] | undefined,
    right: ProviderFundPayload["macro_indicators"] | undefined
  ): ProviderFundPayload["macro_indicators"] | undefined {
    if (!left?.length && !right?.length) return left ?? right;
    const merged = new Map<string, NonNullable<ProviderFundPayload["macro_indicators"]>[number]>();
    for (const indicator of [...(left ?? []), ...(right ?? [])]) {
      merged.set(`${indicator.country_code}:${indicator.indicator_id}:${indicator.date}`, indicator);
    }
    return [...merged.values()];
  }

  private recordCountFor(data: ProviderFundPayload | null): number | null {
    if (!data) return null;
    if (data.nav_history?.length) return data.nav_history.length;
    if (data.macro_indicators?.length) return data.macro_indicators.length;
    if (data.portfolio_holdings?.length) return data.portfolio_holdings.length;
    if (data.fund_report_documents?.length) return data.fund_report_documents.length;
    if (data.fund_report_refs?.length) return data.fund_report_refs.length;
    if (data.policy_signals?.length) return data.policy_signals.length;
    if (data.news_summaries?.length) return data.news_summaries.length;
    return null;
  }

  private latestDateFor(dates: Array<string | null>): string | null {
    return dates.filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;
  }

  private buildEvidence(providerResults: Array<DataProviderResult<ProviderFundPayload>>): EvidenceItem[] {
    return providerResults.map((result) => ({
      title: `${result.source_name} 数据获取${result.success ? "成功" : "失败"}`,
      source_name: result.source_name,
      source_type: this.evidenceSourceTypeFor(result),
      trust_level: result.trust_level,
      summary: result.success
        ? `数据状态 ${result.data_status}，freshness=${result.freshness}。`
        : `数据源失败：${result.error ?? "unknown error"}。`,
      importance_score: result.success ? 0.8 : 0.65,
      related_theme: null,
      published_at: result.fetched_at,
      url: result.raw_reference,
      is_mock: result.is_demo
    }));
  }

  private officialReportGapWarnings(results: Array<DataProviderResult<ProviderFundPayload>>): string[] {
    const documents = results.flatMap((result) =>
      (result.data?.fund_report_documents ?? []).map((document) => ({
        sourceId: result.source_id,
        sourceName: result.source_name,
        trustLevel: result.trust_level,
        document
      }))
    );
    const officialDocuments = documents.filter(({ document }) => document.source_type === "official_disclosure");
    const officialPeriodicDocuments = officialDocuments.filter(({ document }) => document.document_kind === "periodic_report");
    const unverifiedOfficialPdfs = officialPeriodicDocuments.filter(({ document }) => Boolean(document.pdf_url) && !document.pdf_verified);
    const reportNotices = officialDocuments.filter(({ document }) => document.document_kind === "report_notice");
    const aggregatorDocuments = documents.filter(({ document }) => document.source_type === "aggregator_index");
    const warnings: string[] = [];

    if (unverifiedOfficialPdfs.length) {
      const sample = unverifiedOfficialPdfs
        .slice(0, 3)
        .map(({ sourceId, document }) => `${sourceId}:${document.announcement_id}`)
        .join(", ");
      warnings.push(`official_fund_reports 缺口：已发现官方定期报告 PDF 但未通过元数据校验（${sample}）。必须校验 PDF content-type/content-length 或改用授权/人工导入官方 PDF。`);
    }
    if (!unverifiedOfficialPdfs.length && reportNotices.length) {
      const sample = reportNotices
        .slice(0, 3)
        .map(({ sourceId, document }) => `${sourceId}:${document.announcement_id}`)
        .join(", ");
      warnings.push(`official_fund_reports 缺口：当前仅有官方报告提示公告（${sample}），不能视为完整定期报告正文或已校验 PDF。`);
    }
    if (!officialPeriodicDocuments.length && !reportNotices.length && aggregatorDocuments.length) {
      warnings.push("official_fund_reports 缺口：当前只有聚合公告索引或第三方 PDF，仍需基金公司/监管/巨潮等官方披露源交叉验证。");
    }
    if (!documents.length) {
      warnings.push("official_fund_reports 缺口：未获取到任何基金报告文档元数据。");
    }
    return [...new Set(warnings)];
  }

  private hasAuthoritativeField<K extends keyof ProviderFundPayload>(results: Array<DataProviderResult<ProviderFundPayload>>, field: K): boolean {
    return results.some((result) => this.isAuthoritative(result) && result.data?.[field] !== undefined && result.data?.[field] !== null);
  }

  private isAuthoritative(result: DataProviderResult<ProviderFundPayload>): boolean {
    return !result.is_demo && result.source_type !== "manual_import" && (result.trust_level === "A" || ["regulatory_disclosure", "fund_company"].includes(result.source_type));
  }

  private evidenceSourceTypeFor(result: DataProviderResult<ProviderFundPayload>): EvidenceItem["source_type"] {
    if (result.is_demo) return "demo";
    if (result.source_type === "policy") return "policy";
    if (result.source_type === "fund_report" || result.source_type === "regulatory_disclosure" || result.source_type === "fund_company") return "fund_report";
    if (result.source_type === "news") return "news";
    if (result.source_type === "social") return "social";
    if (result.source_type === "manual_import") return "industry_data";
    return "industry_data";
  }

  private scoreFor(
    dataStatus: DataStatus,
    missingCoreCount: number,
    realSuccessCount: number,
    demoSuccessCount: number,
    failedCount: number,
    hasNavConflict = false
  ): number {
    if (dataStatus === "demo") return 35;
    if (dataStatus === "unavailable") return 0;
    if (dataStatus === "insufficient") return Math.max(10, 40 - missingCoreCount * 10 - failedCount * 3);
    if (dataStatus === "partial") return Math.min(72, 50 + realSuccessCount * 8 - failedCount * 2 - (hasNavConflict ? 18 : 0));
    return Math.min(95, 78 + realSuccessCount * 5 - failedCount - (hasNavConflict ? 18 : 0));
  }

  private confidenceFor(dataStatus: DataStatus, score: number): number {
    if (dataStatus === "demo") return 0.35;
    if (dataStatus === "unavailable") return 0.05;
    if (dataStatus === "insufficient") return 0.2;
    if (dataStatus === "partial") return Math.min(0.6, score / 100);
    return Math.min(0.9, score / 100);
  }

  private summaryFor(dataPack: FundDataPack): string {
    const quality = dataPack.data_quality_report;
    if (quality.data_status === "ready") {
      return `Argus 已获取真实核心数据，允许后续 Agent 分析；强结论允许=${quality.allow_strong_conclusion}。`;
    }
    if (quality.data_status === "demo") {
      return "Argus 当前仅获取到 demo fixture 数据，只能用于演示，不能用于真实投资判断，也不允许强结论。";
    }
    const missingFields = [...quality.missing_core_fields, ...quality.missing_auxiliary_fields];
    const missing = missingFields.length ? missingFields.join(", ") : "非核心证据";
    return `Argus 未能获取足够真实数据，data_status=${quality.data_status}，缺失=${missing}，允许后续分析=${quality.allow_downstream_analysis}，允许强结论=${quality.allow_strong_conclusion}。`;
  }

  private hasAuthoritativeFundReportDocument(results: Array<DataProviderResult<ProviderFundPayload>>): boolean {
    return results.some((result) =>
      result.source_type !== "manual_import" &&
      result.trust_level === "A" &&
      result.data?.fund_report_documents?.some(
        (document) =>
          document.source_type === "official_disclosure" &&
          document.trust_level === "A" &&
          document.document_kind === "periodic_report" &&
          document.pdf_verified === true &&
          Boolean(document.pdf_url)
      )
    );
  }
}
