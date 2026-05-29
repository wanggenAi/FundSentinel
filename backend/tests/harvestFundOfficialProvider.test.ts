import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { HarvestFundOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const harvestDetailHtml = `
<html>
  <head>
    <title>【官网】嘉实优化红利混合A(070032)_基金净值估值_投资理财-嘉实基金</title>
    <meta name="Description" content="嘉实优化红利混合A(070032)由嘉实基金管理有限公司管理。" />
  </head>
  <body>
    <input id="product_id" value="212" type="hidden" />
    <h2 id="product_title"><i class="fund"></i>嘉实优化红利混合A<em>070032</em></h2>
    <span id="product_type">主动股票类</span>
    <a href="/trade">登录</a>
  </body>
</html>
`;

const harvestDetailListHtml = `
<table>
  <tr>
    <td><font><a target="_top" href="/Services/cn/html/product/index.shtml?fundcode=070032">嘉实优化红利混合A</a></font></td>
    <td width="72">2026-05-28</td>
    <td width="70">1.480</td>
    <td width="70">3.360</td>
    <td width="56" class="updn">-1.14%</td>
    <td width="56">0.00%</td>
    <td width="56">10.13%</td>
    <td width="56">7.65%</td>
    <td width="56">-1.34%</td>
    <td width="35"><a href="NavHistory.jsp?SiteID=1&FundCode=070032" target="_blank">历史净值</a></td>
  </tr>
</table>
`;

const harvestHistoryHtml = `
<html>
  <body>
    <select name="FundCode">
      <option value="070032" selected="selected">嘉实优化红利混合A</option>
    </select>
    <table>
      <tr><th>日期</th><th>份额净值</th><th>累计净值</th></tr>
      <tr><td>2026-05-28</td><td>1.478</td><td>3.364</td></tr>
      <tr><td>2026-05-27</td><td>1.495</td><td>3.381</td></tr>
      <tr><td>2026-05-26</td><td>1.500</td><td>3.386</td></tr>
    </table>
  </body>
</html>
`;

test("Harvest official parser extracts product shell, current NAV list, and history rows", () => {
  const detail = HarvestFundOfficialProvider.parseFundDetailPage(harvestDetailHtml, "070032");
  const listRow = HarvestFundOfficialProvider.parseDetailList(
    harvestDetailListHtml,
    "070032",
    "https://www.jsfund.cn/Services/cn/jsp/product/DetailList.jsp"
  );
  const navRows = HarvestFundOfficialProvider.parseNavHistoryPage(harvestHistoryHtml, "070032");

  assert.equal(detail.productId, "212");
  assert.equal(detail.fundName, "嘉实优化红利混合A");
  assert.equal(detail.fundType, "主动股票类");
  assert.equal(listRow?.fundName, "嘉实优化红利混合A");
  assert.equal(listRow?.date, "2026-05-28");
  assert.equal(listRow?.currentNav, 1.48);
  assert.equal(listRow?.accumulatedNav, 3.36);
  assert.equal(listRow?.dailyReturn, -1.14);
  assert.equal(listRow?.stageReturns.ytd, 0);
  assert.equal(listRow?.stageReturns["1m"], 0.1013);
  assert.equal(listRow?.stageReturns["3m"], 0.0765);
  assert.equal(listRow?.stageReturns["3y"], -0.0134);
  assert.equal(listRow?.detailUrl, "https://www.jsfund.cn/Services/cn/html/product/index.shtml?fundcode=070032");
  assert.equal(listRow?.historyUrl, "https://www.jsfund.cn/Services/cn/jsp/product/NavHistory.jsp?SiteID=1&FundCode=070032");
  assert.deepEqual(
    navRows.map((row) => row.date),
    ["2026-05-26", "2026-05-27", "2026-05-28"]
  );
  assert.deepEqual(
    navRows.map((row) => row.nav),
    [1.5, 1.495, 1.478]
  );
  assert.equal(HarvestFundOfficialProvider.parseHistoryFundName(harvestHistoryHtml, "070032"), "嘉实优化红利混合A");
});

test("Harvest official provider returns official core NAV without advice or account features", async () => {
  const result = await new HarvestFundOfficialProvider(harvestFetchImpl, 1000).fetch({
    fund_code: "070032",
    required_data: ["fund_meta", "current_nav", "nav_history", "holdings", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "harvestfund-official");
  assert.equal(result.source_type, "fund_company");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "嘉实优化红利混合A");
  assert.equal(result.data?.fund_type, "主动股票类");
  assert.equal(result.data?.current_nav, 1.48);
  assert.equal(result.data?.daily_return, -1.14);
  assert.deepEqual(result.data?.nav_history, [1.5, 1.495, 1.478]);
  assert.deepEqual(result.data?.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(result.data?.stage_returns?.["1m"], 0.1013);
  assert.equal(result.data?.portfolio_holdings, undefined);
  assert.equal(result.data?.fund_report_documents, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("基金公司官方来源")));
  assert.ok(result.warnings.some((warning) => warning.includes("存在差异")));
  assert.ok(result.warnings.some((warning) => warning.includes("official_fund_reports")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("Harvest official provider fails explicitly when official pages have no verifiable fund data", async () => {
  const fetchImpl = (async () =>
    new Response("<html><title>404</title><p>页面不存在</p></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })) as typeof fetch;

  const result = await new HarvestFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /Fund not found/);
  assert.ok(result.warnings.some((warning) => warning.includes("未返回可验证")));
});

test("Argus recognizes Harvest official provider as official core NAV coverage", async () => {
  const registry = new SourceRegistry({
    providers: [new HarvestFundOfficialProvider(harvestFetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("harvest-official-flow", "070032");

  assert.equal(dataPack.fund_name, "嘉实优化红利混合A");
  assert.equal(dataPack.current_nav, 1.48);
  assert.deepEqual(dataPack.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(dataPack.data_status, "partial");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.ok(dataPack.data_quality_report.source_composition.authoritative.includes("harvestfund-official"));
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_meta, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.current_nav, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.holdings, false);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "harvestfund-official" && source.record_count === 3));
});

function harvestFetchImpl(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/main/fund/070032/fundManager.shtml")) return Promise.resolve(htmlResponse(harvestDetailHtml));
  if (url.includes("DetailList.jsp")) return Promise.resolve(htmlResponse(harvestDetailListHtml));
  if (url.includes("NavHistory.jsp")) return Promise.resolve(htmlResponse(harvestHistoryHtml));
  return Promise.resolve(htmlResponse("<html></html>"));
}

function htmlResponse(html: string): Response {
  return new Response(Buffer.from(html, "utf8"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}
