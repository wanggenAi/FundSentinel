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
