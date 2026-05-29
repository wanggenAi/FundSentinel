import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { ChinaAmcOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const chinaAmcDetailHtml = `
<div class="j-tit">
  <div id="nametext"><a title="华夏成长混合" id="text"> 华夏成长混合</a></div>
  <div id="codetext">（基金代码：000001）</div>
</div>
<div class="txt">混合型</div>
<div class="txt">中高风险(R4)</div>
<div class="middle-cont">
  <div class="item"><div class="t1"><span>68.55<span>%</span></span></div><div class="t2">近一年涨跌幅</div></div>
  <div class="item"><div class="t1">1.356</div><div class="t2">净值（2026-05-28）</div></div>
  <div class="item"><div class="t1"><span class="red">1.73%</span></div><div class="t2">日涨跌幅</div></div>
</div>
`;

const chinaAmcNavHtml = `
<table class="table-cont">
  <tbody>
    <tr>
      <td>2026-05-28</td>
      <td><span>1.356</span></td>
      <td>3.929</td>
      <td></td>
    </tr>
    <tr>
      <td>2026-05-27</td>
      <td><span>1.333</span></td>
      <td>3.906</td>
      <td></td>
    </tr>
    <tr>
      <td>2026-05-26</td>
      <td><span>1.364</span></td>
      <td>3.937</td>
      <td></td>
    </tr>
  </tbody>
</table>
`;

const chinaAmcPortfolioHtml = `
<div class="tit paddtop">前十股票
  <div class="st">截止日期  2026-03-31</div>
</div>
<div class="liner3 clearfix border">
  <div class="li middle-box">
    <div class="middle-cont">
      <div class="div clearfix">
        <div class="item">股票代码</div>
        <div class="item">股票简称</div>
        <div class="item">占净值比（%）</div>
      </div>
    </div>
  </div>
  <div class="li middle-box">
    <div class="middle-cont">
      <div class="div clearfix">
        <div class="item">300308</div>
        <div class="item">中际旭创</div>
        <div class="item">4.31</div>
      </div>
    </div>
  </div>
  <div class="li middle-box">
    <div class="middle-cont">
      <div class="div clearfix">
        <div class="item">688012</div>
        <div class="item">中微公司</div>
        <div class="item">3.07</div>
      </div>
    </div>
  </div>
</div>
`;

const chinaAmcNoticeListHtml = `
<div class="li middle-box">
  <div class="middle-cont">
    <div class="div">
      <div class="item"><a target="_blank" href="../c/2026-05-29/940001.shtml"> 000001_华夏成长证券投资基金招募说明书更新（2026年5月29日公告）</a></div>
      <div class="item">2026-05-29</div>
    </div>
  </div>
</div>
<div class="li middle-box">
  <div class="middle-cont">
    <div class="div">
      <div class="item"><a target="_blank" href="../c/2026-04-22/934114.shtml"> 华夏成长证券投资基金2026年第1季度报告</a></div>
      <div class="item">2026-04-22</div>
    </div>
  </div>
</div>
<div class="li middle-box">
  <div class="middle-cont">
    <div class="div">
      <div class="item"><a target="_blank" href="../c/2025-09-18/904790.shtml"> 华夏成长证券投资基金第二十五次分红公告</a></div>
      <div class="item">2025-09-18</div>
    </div>
  </div>
</div>
`;

const chinaAmcReportDetailHtml = `
<html>
  <head><title>华夏成长证券投资基金2026年第1季度报告 - 公告查询 - 华夏基金</title></head>
  <body>
    <div class="article1">
      <div class="tit">
        <div class="t">华夏成长证券投资基金2026年第1季度报告</div>
        <div class="p">时间：2026-04-22&emsp;&emsp;字号：中</div>
      </div>
      <div class="cont">
        <p><a href="/upload/resources/file/2026/04/22/chinaamc-000001-2026q1.pdf" target="_blank">华夏成长证券投资基金2026年第1季度报告</a></p>
      </div>
    </div>
  </body>
</html>
`;

const chinaAmcSalesDocumentHtml = `
<html>
  <body>
    <div class="article1">
      <div class="tit">
        <div class="t">000001_华夏成长证券投资基金招募说明书更新（2026年5月29日公告）</div>
        <div class="p">时间：2026-05-29&emsp;&emsp;字号：中</div>
      </div>
      <div class="cont">
        <a href="/upload/resources/file/2026/05/29/chinaamc-000001-prospectus.pdf">招募说明书更新</a>
      </div>
    </div>
  </body>
</html>
`;

test("ChinaAMC official parser extracts fund detail, NAV, holdings, and notices", () => {
  const detail = ChinaAmcOfficialProvider.parseFundDetailPage(chinaAmcDetailHtml, "000001");
  const navRows = ChinaAmcOfficialProvider.parseNavRows(chinaAmcNavHtml);
  const portfolio = ChinaAmcOfficialProvider.parsePortfolioPage(chinaAmcPortfolioHtml);
  const notices = ChinaAmcOfficialProvider.parseNoticeList(chinaAmcNoticeListHtml, "https://www.chinaamc.com/product/publishGgList.do?fundcode=000001");

  assert.equal(detail.fundName, "华夏成长混合");
  assert.equal(detail.fundType, "混合型");
  assert.equal(detail.currentNav, 1.356);
  assert.equal(detail.currentNavDate, "2026-05-28");
  assert.equal(detail.dailyReturn, 1.73);
  assert.deepEqual(
    navRows.map((row) => row.date),
    ["2026-05-26", "2026-05-27", "2026-05-28"]
  );
  assert.deepEqual(
    navRows.map((row) => row.nav),
    [1.364, 1.333, 1.356]
  );
  assert.deepEqual(portfolio.holdings, ["中际旭创(300308)", "中微公司(688012)"]);
  assert.equal(portfolio.holdingsAsOf, "2026-03-31");
  assert.equal(notices.length, 3);
  assert.equal(notices[1]?.detailUrl, "https://www.chinaamc.com/c/2026-04-22/934114.shtml");
});

test("ChinaAMC official parser discovers official report PDFs from detail pages", () => {
  const parsed = ChinaAmcOfficialProvider.parseNoticeDetailPage(
    chinaAmcReportDetailHtml,
    "https://www.chinaamc.com/c/2026-04-22/934114.shtml"
  );

  assert.equal(parsed.title, "华夏成长证券投资基金2026年第1季度报告");
  assert.equal(parsed.publishedAt, "2026-04-22");
  assert.equal(parsed.pdfUrl, "https://www.chinaamc.com/upload/resources/file/2026/04/22/chinaamc-000001-2026q1.pdf");
});

test("ChinaAMC official provider returns official core data without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/product/fundLishijingzhi.do")) return htmlResponse(chinaAmcNavHtml);
    if (url.includes("/zichanzuhe.shtml")) return htmlResponse(chinaAmcPortfolioHtml, "gb18030");
    if (url.includes("/product/publishGgList.do")) return htmlResponse(chinaAmcNoticeListHtml);
    if (url.endsWith("/c/2026-04-22/934114.shtml")) return htmlResponse(chinaAmcReportDetailHtml);
    if (url.endsWith("/c/2026-05-29/940001.shtml")) return htmlResponse(chinaAmcSalesDocumentHtml);
    if (url.endsWith(".pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "654321" }
      });
    }
    return htmlResponse(chinaAmcDetailHtml, "gb18030");
  }) as typeof fetch;

  const result = await new ChinaAmcOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "000001",
    required_data: ["fund_meta", "current_nav", "nav_history", "holdings", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "chinaamc-official");
  assert.equal(result.source_type, "fund_company");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "华夏成长混合");
  assert.equal(result.data?.current_nav, 1.356);
  assert.deepEqual(result.data?.nav_history, [1.364, 1.333, 1.356]);
  assert.deepEqual(result.data?.portfolio_holdings, ["中际旭创(300308)", "中微公司(688012)"]);
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "sales_document");
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_url, "https://www.chinaamc.com/upload/resources/file/2026/04/22/chinaamc-000001-2026q1.pdf");
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[1]?.pdf_content_length, 654321);
  assert.ok(result.warnings.some((warning) => warning.includes("基金公司官方来源")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("ChinaAMC official provider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    htmlResponse("404notfound", "gb18030")) as typeof fetch;

  const result = await new ChinaAmcOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /Fund not found/);
});

test("Argus recognizes ChinaAMC official provider as official core coverage", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/product/fundLishijingzhi.do")) return htmlResponse(chinaAmcNavHtml);
    if (url.includes("/zichanzuhe.shtml")) return htmlResponse(chinaAmcPortfolioHtml, "gb18030");
    if (url.includes("/product/publishGgList.do")) return htmlResponse(chinaAmcNoticeListHtml);
    if (url.endsWith("/c/2026-04-22/934114.shtml")) return htmlResponse(chinaAmcReportDetailHtml);
    if (url.endsWith("/c/2026-05-29/940001.shtml")) return htmlResponse(chinaAmcSalesDocumentHtml);
    if (url.endsWith(".pdf") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "654321" }
      });
    }
    return htmlResponse(chinaAmcDetailHtml, "gb18030");
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new ChinaAmcOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("chinaamc-official-flow", "000001");

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
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "chinaamc-official" && source.record_count === 3));
});

function htmlResponse(html: string, charset = "utf-8"): Response {
  return new Response(Buffer.from(html, "utf8"), {
    status: 200,
    headers: { "content-type": `text/html; charset=${charset === "gb18030" ? "utf-8" : charset}` }
  });
}
