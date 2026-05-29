import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import {
  CmfChinaFundOfficialProvider,
  EastMoneyFundProvider,
  EastMoneyNavHistoryProvider,
  GovCnPolicyProvider,
  ManualCsvProvider,
  SourceRegistry,
  WorldBankMacroProvider
} from "../src/dataSources/index.js";
import type { DataProviderResult, DataProvider, DataSourceInfo, FundDataSourceInput, ProviderFundPayload } from "../src/dataSources/index.js";

const eastMoneyText = `
var fS_name = "招商信用增强债券C";var fS_code = "007951";
var Data_netWorthTrend = [
  {"x":1779840000000,"y":1.0801,"equityReturn":-0.19,"unitMoney":""},
  {"x":1779926400000,"y":1.0799,"equityReturn":-0.02,"unitMoney":""}
];
`;

const navHistoryJson = JSON.stringify({
  Data: {
    LSJZList: [
      { FSRQ: "2026-05-28", DWJZ: "1.0799", JZZZL: "-0.02" },
      { FSRQ: "2026-05-27", DWJZ: "1.0801", JZZZL: "-0.19" }
    ]
  }
});

const govPolicyJson = JSON.stringify([
  {
    TITLE: "国务院关于稳定经济增长的政策文件",
    URL: "https://www.gov.cn/zhengce/content/test.htm",
    DOCRELPUBTIME: "2026-05-20"
  }
]);

const worldBankJson = JSON.stringify([
  { page: 1, pages: 1, per_page: 1, total: 1 },
  [
    {
      indicator: { id: "NY.GDP.MKTP.KD.ZG", value: "GDP growth (annual %)" },
      country: { id: "CN", value: "China" },
      date: "2025",
      value: 5.1
    }
  ]
]);

const cmfFundDetailHtml = `
<div class="pro_name"><div class="title"><h5>招商信用增强债券C</h5><a class="type_switch"></a></div>
<div class="info"><span class="fund_code">007951</span><span class="fund_tag">中低风险(R2)</span><span class="fund_tag">债券型</span></div></div>
<div class="num"><strong>1.0799</strong></div><p>单位净值(2026-05-28)</p>
<div class="color_green num"><strong>-0.02%</strong></div><p>日涨幅</p>
<script>
fw.pageNum=1;fw.pageSize=10;fw.total=2;fw.pages=1;fw.list=[
  {valueId:2337093,productId:342717,relatePrice:E,cumulativeNet:F,navDate:j,dayRate:U,productCode:d},
  {valueId:2336333,productId:342717,relatePrice:"1.0801",cumulativeNet:"1.3283",navDate:"2026-05-27",dayRate:"-0.194",productCode:d}
];return {data:{"fundNavPage-007951-[object Object]":fw}};
</script>
<a class="item" href="/web/noticedetails/223506/index.html" target="_blank"><p>招商基金管理有限公司旗下基金2026年第1季度报告提示性公告</p><span class="date">2026-04-22</span></a>
`;

class UnverifiedOfficialReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "unverified-official-report-test",
      source_name: "Unverified Official Report Test Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test provider",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "unverified-official-report-test",
      source_name: "Unverified Official Report Test Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "招商信用增强债券C",
        fund_type: "债券型",
        current_nav: 1.0799,
        nav_history: [1.0801, 1.0799],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        fund_report_refs: ["2026-04-22 招商信用增强债券C2026年第1季度报告 pdf_verified=false"],
        fund_report_documents: [
          {
            title: "招商信用增强债券C2026年第1季度报告",
            announcement_id: "unverified-2026q1",
            published_at: "2026-04-22",
            category: null,
            document_kind: "periodic_report",
            detail_url: "https://official.example.test/detail",
            pdf_url: "https://official.example.test/report.pdf",
            pdf_verified: false,
            pdf_content_type: null,
            pdf_content_length: null,
            source_name: "官方披露测试源",
            source_type: "official_disclosure",
            trust_level: "A"
          }
        ]
      },
      raw_reference: "https://official.example.test/detail",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}

class FailingOfficialReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "failing-official-report-test",
      source_name: "Failing Official Report Test Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test provider",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "failing-official-report-test",
      source_name: "Failing Official Report Test Provider",
      source_type: "regulatory_disclosure",
      trust_level: "A",
      data_status: "unavailable",
      success: false,
      data: null,
      raw_reference: "https://official.example.test/reports",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "unknown",
      warnings: ["官方站点防护阻断自动访问"],
      error: "HTTP 403 from official disclosure endpoint",
      is_demo: false
    };
  }
}

class EmptyFundReportProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "empty-fund-report-test",
      source_name: "Empty Fund Report Test Provider",
      source_type: "fund_report",
      trust_level: "A",
      enabled: true,
      priority: 1,
      access_method: "test provider",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "empty-fund-report-test",
      source_name: "Empty Fund Report Test Provider",
      source_type: "fund_report",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "招商信用增强债券C",
        current_nav: 1.0799,
        nav_history: [1.0801, 1.0799],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        policy_signals: ["2026-05-20 官方政策背景证据"],
        news_summaries: ["2026-05-20 官方行业新闻背景证据"],
        macro_indicators: [
          {
            country_code: "CN",
            country_name: "China",
            indicator_id: "NY.GDP.MKTP.KD.ZG",
            indicator_name: "GDP growth",
            value: 5.1,
            date: "2025",
            unit: "percent",
            source_url: "https://api.worldbank.org/test",
            source_name: "World Bank",
            fetched_at: "2026-05-28T00:00:00.000Z"
          }
        ],
        social_sentiment_score: 0.42
      },
      raw_reference: "https://official.example.test/reports",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: "fresh",
      warnings: ["测试 provider 未返回任何报告引用或文档。"],
      error: null,
      is_demo: false
    };
  }
}

class ReadyOfficialCoreProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  constructor(private readonly freshness: DataProviderResult<ProviderFundPayload>["freshness"] = "fresh") {}

  sourceInfo(): DataSourceInfo {
    return {
      source_id: "ready-official-core-test",
      source_name: "Ready Official Core Test Provider",
      source_type: "fund_company",
      trust_level: "A",
      enabled: true,
      priority: 0,
      access_method: "test provider",
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
      freshness_policy: "test",
      notes: "test"
    };
  }

  canHandle(): boolean {
    return true;
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "ready-official-core-test",
      source_name: "Ready Official Core Test Provider",
      source_type: "fund_company",
      trust_level: "A",
      data_status: "ready",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "招商信用增强债券C",
        fund_type: "债券型",
        current_nav: 1.0799,
        daily_return: -0.02,
        nav_history: [1.0801, 1.0799],
        nav_history_dates: ["2026-05-27", "2026-05-28"],
        portfolio_holdings: ["国债", "政策性金融债"],
        fund_report_refs: ["2026-04-22 招商信用增强债券C2026年第1季度报告 pdf_verified=true"],
        fund_report_documents: [
          {
            title: "招商信用增强债券C2026年第1季度报告",
            announcement_id: "verified-2026q1",
            published_at: "2026-04-22",
            category: null,
            document_kind: "periodic_report",
            detail_url: "https://official.example.test/detail",
            pdf_url: "https://official.example.test/report.pdf",
            pdf_verified: true,
            pdf_content_type: "application/pdf",
            pdf_content_length: 2048,
            source_name: "官方披露测试源",
            source_type: "official_disclosure",
            trust_level: "A"
          }
        ],
        policy_signals: ["2026-05-20 官方政策背景证据"],
        macro_indicators: [
          {
            country_code: "CN",
            country_name: "China",
            indicator_id: "NY.GDP.MKTP.KD.ZG",
            indicator_name: "GDP growth",
            value: 5.1,
            date: "2025",
            unit: "percent",
            source_url: "https://api.worldbank.org/test",
            source_name: "World Bank",
            fetched_at: "2026-05-28T00:00:00.000Z"
          }
        ],
        news_summaries: ["2026-05-20 官方行业新闻背景证据"],
        social_sentiment_score: 0.42
      },
      raw_reference: "https://official.example.test/detail",
      fetched_at: "2026-05-28T00:00:00.000Z",
      freshness: this.freshness,
      warnings: this.freshness === "stale" ? ["测试官方核心数据已过期，强结论应降级。"] : [],
      error: null,
      is_demo: false
    };
  }
}

test("Argus source composition separates authoritative, aggregator, manual, and macro sources", async () => {
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyFundProvider(
        (async () =>
          new Response(eastMoneyText, {
            status: 200,
            headers: { "content-type": "application/javascript" }
          })) as typeof fetch,
        1000
      ),
      new EastMoneyNavHistoryProvider(
        (async () =>
          new Response(navHistoryJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      ),
      new GovCnPolicyProvider(
        (async () =>
          new Response(govPolicyJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      ),
      new WorldBankMacroProvider(
        (async () =>
          new Response(worldBankJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000,
        ["CN"],
        [{ id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" }]
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack, result } = await new ArgusAgent(registry).prepareDataPack("source-composition", "007951");
  const composition = dataPack.data_quality_report.source_composition;

  assert.ok(composition.aggregator.includes("eastmoney-fund"));
  assert.ok(composition.aggregator.includes("eastmoney-nav-history"));
  assert.ok(composition.authoritative.includes("gov-cn-policy"));
  assert.ok(composition.macro.includes("world-bank-api"));
  assert.equal(composition.official_core_coverage.fund_meta, false);
  assert.equal(composition.official_core_coverage.current_nav, false);
  assert.equal(composition.official_core_coverage.nav_history, false);
  assert.equal(dataPack.data_quality_report.data_status, "partial");
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"));
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"));
  assert.equal(dataPack.data_quality_report.aggregator_source_count, 2);
  assert.equal(dataPack.data_quality_report.macro_source_count, 1);
  assert.ok(result.evidence.some((item) => item.source_name.includes("EastMoney") && item.source_type === "industry_data"));
});

test("Argus records structured failed provider details in DataGapReport", async () => {
  const registry = new SourceRegistry({
    providers: [new FailingOfficialReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("failed-provider-gap-details", "007951");
  const gapReport = dataPack.data_gap_report;

  assert.ok(gapReport);
  assert.deepEqual(gapReport.failed_sources, ["Failing Official Report Test Provider"]);
  assert.equal(gapReport.failed_source_details.length, 1);
  assert.deepEqual(gapReport.failed_source_details[0], {
    source_id: "failing-official-report-test",
    source_name: "Failing Official Report Test Provider",
    source_type: "regulatory_disclosure",
    trust_level: "A",
    data_status: "unavailable",
    freshness: "unknown",
    fetched_at: "2026-05-28T00:00:00.000Z",
    raw_reference: "https://official.example.test/reports",
    error: "HTTP 403 from official disclosure endpoint",
    warnings: ["官方站点防护阻断自动访问"],
    attempt_count: 1,
    latency_ms: gapReport.failed_source_details[0]?.latency_ms ?? null,
    cache_hit: false,
    skipped_by_circuit_breaker: false,
    circuit_open_until: null
  });
  assert.equal(typeof gapReport.failed_source_details[0]?.latency_ms, "number");
  assert.ok(gapReport.missing_data.includes("fund_meta"));
  assert.equal(dataPack.data_quality_report.failed_source_count, 1);
  assert.ok(dataPack.data_quality_report.source_composition.failed.includes("failing-official-report-test"));
});

test("Argus surfaces SourceRegistry circuit-breaker cooldown in DataGapReport details", async () => {
  const registry = new SourceRegistry({
    providers: [new FailingOfficialReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0,
    failureThreshold: 1,
    failureCooldownMs: 60_000
  });

  await new ArgusAgent(registry).prepareDataPack("open-circuit", "007951");
  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("circuit-gap-details", "007951");
  const detail = dataPack.data_gap_report?.failed_source_details.find((source) => source.source_id === "failing-official-report-test");

  assert.ok(detail);
  assert.equal(detail.skipped_by_circuit_breaker, true);
  assert.equal(detail.attempt_count, 0);
  assert.equal(detail.error, "Provider skipped by circuit breaker after repeated failures.");
  assert.ok(detail.circuit_open_until);
  assert.equal(Number.isNaN(Date.parse(detail.circuit_open_until)), false);
  assert.ok(detail.warnings.some((warning) => warning.includes("circuit breaker is open")));
});

test("Argus keeps provider failures in DataGapReport even when core data is ready", async () => {
  const registry = new SourceRegistry({
    providers: [new ReadyOfficialCoreProvider(), new FailingOfficialReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("ready-with-provider-failure", "007951");
  const gapReport = dataPack.data_gap_report;

  assert.equal(dataPack.data_quality_report.data_status, "ready");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, true);
  assert.ok(gapReport);
  assert.deepEqual(gapReport.missing_data, []);
  assert.deepEqual(gapReport.blocking_downstream_agents, []);
  assert.ok(gapReport.impact.includes("核心数据已满足当前分析"));
  assert.ok(gapReport.failed_source_details.some((source) => source.source_id === "failing-official-report-test"));
  assert.ok(gapReport.recommended_solutions.some((solution) => solution.includes("失败 provider")));
  assert.equal(dataPack.acquisition_solutions[0]?.severity, "medium");
  assert.ok(dataPack.acquisition_solutions[0]?.problem.includes("provider 获取失败"));
});

test("Argus surfaces stale successful providers as data freshness gaps", async () => {
  const registry = new SourceRegistry({
    providers: [new ReadyOfficialCoreProvider("stale")],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("stale-ready-core", "007951");
  const gapReport = dataPack.data_gap_report;

  assert.equal(dataPack.data_quality_report.data_status, "partial");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.deepEqual(dataPack.data_quality_report.stale_sources, ["Ready Official Core Test Provider"]);
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("data_freshness"));
  assert.ok(gapReport?.missing_data.includes("data_freshness"));
  assert.ok(gapReport?.recommended_solutions.some((solution) => solution.includes("freshness=stale")));
  assert.ok(dataPack.acquisition_solutions[0]?.problem.includes("data_freshness"));
  assert.ok(dataPack.acquisition_solutions[0]?.proposed_actions.some((action) => action.includes("stale")));
  assert.ok(dataPack.acquisition_solutions[0]?.engineering_tasks.some((task) => task.includes("freshness fixture")));
});

test("Argus requires actual report evidence before clearing fund report gaps", async () => {
  const registry = new SourceRegistry({
    providers: [new EmptyFundReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("empty-fund-report-provider", "007951");

  assert.equal(dataPack.data_quality_report.source_composition.authoritative.includes("empty-fund-report-test"), true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("fund_reports"), true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_quality_report.warnings.some((warning) => warning.includes("未获取到任何基金报告文档元数据")));
});

test("Argus recognizes official fund-company NAV coverage for core NAV fields", async () => {
  const registry = new SourceRegistry({
    providers: [
      new CmfChinaFundOfficialProvider(
        (async () =>
          new Response(cmfFundDetailHtml, {
            status: 200,
            headers: { "content-type": "text/html" }
          })) as typeof fetch,
        1000,
        0
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("official-nav-composition", "007951");
  const composition = dataPack.data_quality_report.source_composition;

  assert.ok(composition.authoritative.includes("cmfchina-fund-official"));
  assert.equal(composition.official_core_coverage.fund_meta, true);
  assert.equal(composition.official_core_coverage.current_nav, true);
  assert.equal(composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.current_nav, 1.0799);
  assert.deepEqual(dataPack.nav_history_dates, ["2026-05-27", "2026-05-28"]);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"), false);
});

test("Argus explains official report gaps when only report notices are available", async () => {
  const registry = new SourceRegistry({
    providers: [
      new CmfChinaFundOfficialProvider(
        (async () =>
          new Response(cmfFundDetailHtml, {
            status: 200,
            headers: { "content-type": "text/html" }
          })) as typeof fetch,
        1000,
        0
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("official-report-gap-notice", "007951");

  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_quality_report.warnings.some((warning) => warning.includes("当前仅有官方报告提示公告")));
  assert.ok(
    dataPack.data_gap_report?.recommended_solutions.some((solution) => solution.includes("只有提示性公告、聚合索引或未校验 PDF 不能放行强结论"))
  );
});

test("Argus explains official report gaps when official PDFs are not verified", async () => {
  const registry = new SourceRegistry({
    providers: [new UnverifiedOfficialReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("official-report-gap-unverified-pdf", "007951");

  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_quality_report.warnings.some((warning) => warning.includes("已发现官方定期报告 PDF 但未通过元数据校验")));
  assert.ok(dataPack.data_gap_report?.recommended_solutions.some((solution) => solution.includes("HEAD 校验并记录 content-type/content-length")));
});

test("Argus source composition recognizes manual import separately from aggregator sources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-source-composition-"));
  try {
    await writeFile(
      path.join(dir, "007951.csv"),
      [
        "fund_code,date,nav,fund_name,fund_type",
        "007951,2026-05-27,1.0801,招商信用增强债券C,债券型",
        "007951,2026-05-28,1.0799,招商信用增强债券C,债券型"
      ].join("\n")
    );

    const registry = new SourceRegistry({
      providers: [new ManualCsvProvider(dir)],
      cacheTtlMs: 0,
      retryCount: 0
    });
    const { dataPack } = await new ArgusAgent(registry).prepareDataPack("manual-source-composition", "007951");
    const composition = dataPack.data_quality_report.source_composition;

    assert.ok(composition.manual.includes("manual-csv-import"));
    assert.equal(composition.aggregator.length, 0);
    assert.equal(dataPack.data_quality_report.manual_source_count, 1);
    assert.equal(composition.official_core_coverage.current_nav, false);
    assert.equal(composition.official_core_coverage.nav_history, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
