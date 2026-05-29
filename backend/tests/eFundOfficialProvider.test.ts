import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { EFundOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const eFundDetailHtml = `
<script>
  var fundCode = "110011";
  var fundName = "易方达优质精选混合型证券投资基金";
  var shortName = "易方达优质精选混合（QDII）";
</script>
<div id="net-today">4.3918</div>
<div id="net-scale" style="color:#009b6d">-1.36%</div>
<div id="net-totsl">6.1818</div>
<div class="source-fund">基金净值日期：<span class="nav-update">2026-05-28</span></div>
<table class="baseinfo-table">
  <tr class="baseinfo-table-row">
    <td class="baseinfo-table-left">基金名称:</td>
    <td class="baseinfo-table-right">易方达优质精选混合型证券投资基金 </td>
  </tr>
  <tr>
    <td class="baseinfo-table-left">基金代码:</td>
    <td class="baseinfo-table-right fundcode" data-fundCode="110011"> 110011 </td>
  </tr>
  <tr>
    <td class="baseinfo-table-left">基金类型:</td>
    <td class="baseinfo-table-right fund-type"> 混合型</td>
  </tr>
</table>
<script>
  var assets_searchDate='2026-03-31'
  var investList = [{"type":"5","typeName":"占基金资产净值前十名股票及存托凭证投资明细","investInfoData":[{"norder":"1","name":"Kweichow Moutai Co.,Ltd.","symbol":"600519 CH","namechinese":"贵州茅台酒股份有限公司"},{"norder":"2","name":"Tencent Holdings Limited","symbol":"700 HK","namechinese":"腾讯控股有限公司"}]}]
//    investList.push(investList[0]);-->
</script>
<tbody id="product_navTBody" data-total="968">
  <tr>
    <td><a href="https://cdn.efunds.com.cn/owch/data/bulletin/20260519/product.pdf" target="_blank">易方达优质精选混合型证券投资基金基金产品资料概要更新</a></td>
    <td>2026-05-19<span style="display: none">800441</span></td>
  </tr>
  <tr>
    <td><a href="https://cdn.efunds.com.cn/owch/data/bulletin/20260422/q1.pdf" target="_blank">易方达优质精选混合型证券投资基金2026年第1季度报告</a></td>
    <td>2026-04-22<span style="display: none">797403</span></td>
  </tr>
  <tr>
    <td><a href="https://cdn.efunds.com.cn/owch/data/bulletin/20260331/annual.pdf" target="_blank">易方达优质精选混合型证券投资基金2025年年度报告</a></td>
    <td>2026-03-31<span style="display: none">794584</span></td>
  </tr>
</tbody>
`;

const eFundNavJs = `mk_110011_all="0_1_2_3_4;20260526_-0.39516000_4.4691_6.2591_-1.01;20260527_-0.39743400_4.4523_6.2423_-0.38;20260528_-0.40562200_4.3918_6.1818_-1.36;";`;

test("EFundOfficialProvider parses official E Fund page details, holdings, and notices", () => {
  const parsed = EFundOfficialProvider.parseFundDetailPage(eFundDetailHtml, "110011");

  assert.equal(parsed.fundName, "易方达优质精选混合型证券投资基金");
  assert.equal(parsed.fundType, "混合型");
  assert.equal(parsed.currentNav, 4.3918);
  assert.equal(parsed.currentNavDate, "2026-05-28");
  assert.equal(parsed.dailyReturn, -1.36);
  assert.equal(parsed.holdingsAsOf, "2026-03-31");
  assert.deepEqual(parsed.holdings, ["贵州茅台酒股份有限公司(600519 CH)", "腾讯控股有限公司(700 HK)"]);
  assert.equal(parsed.notices.length, 3);
  assert.equal(parsed.notices[1]?.announcementId, "797403");
});

test("EFundOfficialProvider parses official CDN NAV history JS", () => {
  const rows = EFundOfficialProvider.parseMarketNavJs(eFundNavJs, "110011");

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.date),
    ["2026-05-26", "2026-05-27", "2026-05-28"]
  );
  assert.deepEqual(
    rows.map((row) => row.nav),
    [4.4691, 4.4523, 4.3918]
  );
  assert.equal(rows[2]?.accumulatedNav, 6.1818);
  assert.equal(rows[2]?.dailyReturn, -1.36);
});

test("EFundOfficialProvider returns official core data without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/market/2.0/his/110011_all.js")) {
      return new Response(eFundNavJs, {
        status: 200,
        headers: { "content-type": "text/javascript" }
      });
    }
    if (url.endsWith(".pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "123456" }
      });
    }
    return new Response(eFundDetailHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new EFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "110011",
    required_data: ["fund_meta", "current_nav", "nav_history", "holdings", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "efund-official");
  assert.equal(result.source_type, "fund_company");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "易方达优质精选混合型证券投资基金");
  assert.equal(result.data?.current_nav, 4.3918);
  assert.deepEqual(result.data?.nav_history, [4.4691, 4.4523, 4.3918]);
  assert.deepEqual(result.data?.portfolio_holdings, ["贵州茅台酒股份有限公司(600519 CH)", "腾讯控股有限公司(700 HK)"]);
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "sales_document");
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_content_length, 123456);
  assert.ok(result.warnings.some((warning) => warning.includes("基金公司官方来源")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("EFundOfficialProvider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/market/2.0/his/")) return new Response(eFundNavJs, { status: 200 });
    return new Response("404notfound", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new EFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /Fund not found/);
});

test("Argus recognizes E Fund official provider as official core coverage", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/market/2.0/his/110011_all.js")) return new Response(eFundNavJs, { status: 200 });
    if (url.endsWith(".pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "123456" }
      });
    }
    return new Response(eFundDetailHtml, { status: 200 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new EFundOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("efund-official-flow", "110011");

  assert.equal(dataPack.data_status, "partial");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.current_nav, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.holdings, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("policy_evidence"), true);
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "efund-official" && source.record_count === 3));
});
