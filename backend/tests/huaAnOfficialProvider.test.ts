import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { HuaAnFundOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const huaAnDetailHtml = `
<h1>华安策略优选A<strong>040008</strong>
  <b class="rlabel_2">R4风险</b>
  <b class="typeico1">混合型</b>
</h1>
<span>最新净值（05-28）<b>2.3240</b></span>
<script>
  var fundCode = "040008";
  fundDate = "2026-05-28";
</script>
<table>
<tr><td class="hd">法定名称</td><td>华安策略优选混合型证券投资基金</td><td class="hd">基金代码</td><td>040008</td></tr>
<tr><td class="hd">基金简称</td><td>华安策略优选混合A</td><td class="hd">成立日期</td><td>2007-08-02</td></tr>
<tr><td class="hd">基金类型</td><td>混合型</td><td class="hd">交易状态</td><td>开放申购</td></tr>
</table>
<div class="fund_infos_bx_t">
  <li class="li1"><span class="f_333">日期</span><br><span>2026-05-28</span></li>
  <li class="li2"><span class="f_333">单位净值</span><br><span>2.3240</span></li>
  <li class="li3"><span class="f_333">累计净值</span><br><span>3.8603</span></li>
  <li class="li4"><span class="f_333">涨跌</span><br><span class="f_red">1.92%</span></li>
</div>
<h4><span class="fr">以下数据截止2026-03-31</span><span class="f_333">报告期末按公允价值占基金资产净值比例大小排序的前十名股票投资明细：</span></h4>
<table class="table_tzzh">
  <tr><th>股票代码</th><th>股票名称</th></tr>
  <tr><td>601872</td><td>招商轮船</td><td>12,327,404</td><td class="td3">201,676,329.44</td><td class="td4">6.62</td></tr>
  <tr><td>600309</td><td>万华化学</td><td>2,030,400</td><td class="td3">161,315,280.00</td><td class="td4">5.30</td></tr>
</table>
<li><span class="fr">2026-04-22</span><a href="/news/2026-04-22/123456_1.shtml" target="_blank">华安策略优选混合型证券投资基金2026年第1季度报告</a></li>
<li><span class="fr">2026-05-19</span><a href="/news/2026-05-19/123457_1.shtml" target="_blank">关于华安策略优选混合型证券投资基金暂停大额申购的公告</a></li>
`;

const huaAnNavTableHtml = `
<table class="table_bx">
  <tr><th>日期</th><th>单位净值</th><th>累计净值</th><th>涨跌</th></tr>
  <tr>
    <td class="th1">2026-05-28</td>
    <td class="th2">2.3240</td>
    <td class="th2">3.8603</td>
    <td class="th3"><span class="f_red">1.92%</span></td>
  </tr>
  <tr>
    <td class="th1">2026-05-27</td>
    <td class="th2">2.2802</td>
    <td class="th2">3.8165</td>
    <td class="th3"><span class="f_green">-0.55%</span></td>
  </tr>
  <tr>
    <td class="th1">2026-05-26</td>
    <td class="th2">2.2929</td>
    <td class="th2">3.8292</td>
    <td class="th3"><span class="f_red">0.71%</span></td>
  </tr>
</table>
`;

const huaAnReportDetailHtml = `
<html>
  <head><title>华安策略优选混合型证券投资基金2026年第1季度报告</title></head>
  <body>
    <h1>华安策略优选混合型证券投资基金2026年第1季度报告</h1>
    <div class="date">发布时间：2026-04-22</div>
    <p>本报告全文同步登载于华安基金官网。</p>
    <a href="/upload/report/040008-2026q1.pdf">下载PDF全文</a>
  </body>
</html>
`;

const huaAnBusinessNoticeHtml = `
<html>
  <body>
    <h1>关于华安策略优选混合型证券投资基金暂停大额申购的公告</h1>
    <div class="date">发布时间：2026-05-19</div>
  </body>
</html>
`;

test("HuaAn official parser extracts fund detail, NAV, holdings, and notices", () => {
  const parsed = HuaAnFundOfficialProvider.parseFundDetailPage(huaAnDetailHtml, "040008");
  const navRows = HuaAnFundOfficialProvider.parseNavTable(huaAnNavTableHtml);

  assert.equal(parsed.fundName, "华安策略优选A");
  assert.equal(parsed.fundType, "混合型");
  assert.equal(parsed.currentNav, 2.324);
  assert.equal(parsed.currentNavDate, "2026-05-28");
  assert.equal(parsed.dailyReturn, 1.92);
  assert.deepEqual(parsed.holdings, ["招商轮船(601872)", "万华化学(600309)"]);
  assert.equal(parsed.holdingsAsOf, "2026-03-31");
  assert.equal(parsed.notices.length, 2);
  assert.equal(navRows.length, 3);
  assert.deepEqual(
    navRows.map((row) => row.date),
    ["2026-05-26", "2026-05-27", "2026-05-28"]
  );
  assert.deepEqual(
    navRows.map((row) => row.nav),
    [2.2929, 2.2802, 2.324]
  );
});

test("HuaAn official parser discovers report PDFs from official notice details", () => {
  const parsed = HuaAnFundOfficialProvider.parseNoticeDetailPage(
    huaAnReportDetailHtml,
    "https://www.huaan.com.cn/news/2026-04-22/123456_1.shtml"
  );

  assert.equal(parsed.title, "华安策略优选混合型证券投资基金2026年第1季度报告");
  assert.equal(parsed.publishedAt, "2026-04-22");
  assert.equal(parsed.pdfUrl, "https://www.huaan.com.cn/upload/report/040008-2026q1.pdf");
  assert.equal(parsed.mentionsCompanyWebsite, true);
});

test("HuaAn official provider returns official core data without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("selectFundayByCode.do")) {
      return new Response(huaAnNavTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.endsWith("/news/2026-04-22/123456_1.shtml")) {
      return new Response(huaAnReportDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.endsWith("/news/2026-05-19/123457_1.shtml")) {
      return new Response(huaAnBusinessNoticeHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.endsWith("/upload/report/040008-2026q1.pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "456789" }
      });
    }
    return new Response(huaAnDetailHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new HuaAnFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "040008",
    required_data: ["fund_meta", "current_nav", "nav_history", "holdings", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "huaan-fund-official");
  assert.equal(result.source_type, "fund_company");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "华安策略优选A");
  assert.equal(result.data?.current_nav, 2.324);
  assert.deepEqual(result.data?.nav_history, [2.2929, 2.2802, 2.324]);
  assert.deepEqual(result.data?.portfolio_holdings, ["招商轮船(601872)", "万华化学(600309)"]);
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "official_disclosure");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_url, "https://www.huaan.com.cn/upload/report/040008-2026q1.pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_length, 456789);
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "business_notice");
  assert.ok(result.warnings.some((warning) => warning.includes("基金公司官方来源")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("HuaAn official provider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("欢迎访问本站点，你的此次请求暂不能处理", {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new HuaAnFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /Fund not found/);
});

test("Argus recognizes HuaAn official provider as official core NAV coverage", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    return new Response(url.includes("selectFundayByCode.do") ? huaAnNavTableHtml : huaAnDetailHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new HuaAnFundOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("huaan-flow", "040008");

  assert.equal(dataPack.data_status, "partial");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.current_nav, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.holdings, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "huaan-fund-official" && source.record_count === 3));
});

test("Argus counts HuaAn official reports only after official PDF metadata is verified", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("selectFundayByCode.do")) {
      return new Response(huaAnNavTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.endsWith("/news/2026-04-22/123456_1.shtml")) {
      return new Response(huaAnReportDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.endsWith("/upload/report/040008-2026q1.pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "456789" }
      });
    }
    return new Response(huaAnDetailHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new HuaAnFundOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("huaan-official-report-flow", "040008");

  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
});
