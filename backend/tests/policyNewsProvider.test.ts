import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { NdrcOfficialProvider, PolicyNewsProvider, SourceRegistry } from "../src/dataSources/index.js";

const ndrcNewsHtml = `
<ul class="u-list">
  <li><a href="./202605/t20260522_1405405.html" target="_blank" title="国家发展改革委举行5月份新闻发布会">国家发展改革委举行5月份新闻发布会</a><span>2026/05/22</span></li>
  <li><a href="./202605/t20260521_1405346.html" target="_blank" title="2026年5月21日国内成品油价格调整">2026年5月21日国内成品油价格调整</a><span>2026/05/21</span></li>
  <li><a href="./202605/t20260520_1405329.html" target="_blank" title="郑栅洁主任主持召开民营企业座谈会 围绕当前经济形势及宏观政策落实情况听取意见建议">郑栅洁主任主持召开民营企业座谈会 围绕当前经济形势及宏观政策落实情况听取意见建议</a><span>2026/05/20</span></li>
  <li><a href="./202605/t20260509_1405123.html" target="_blank" title="郑栅洁主任赴上海人工智能实验室调研">郑栅洁主任赴上海人工智能实验室调研</a><span>2026/05/09</span></li>
</ul>
`;

test("PolicyNewsProvider parses official NDRC news releases", () => {
  const items = PolicyNewsProvider.parseNdrcNewsList(ndrcNewsHtml, "https://www.ndrc.gov.cn/xwdt/xwfb/");

  assert.equal(items.length, 4);
  assert.equal(items[0]?.title, "国家发展改革委举行5月份新闻发布会");
  assert.equal(items[0]?.published_at, "2026-05-22");
  assert.equal(items[0]?.url, "https://www.ndrc.gov.cn/xwdt/xwfb/202605/t20260522_1405405.html");
  assert.equal(items[0]?.source_name, "国家发展改革委");
});

test("NDRC official provider returns official industry-policy evidence without advice", async () => {
  const fetchImpl = (async () =>
    new Response(ndrcNewsHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const provider = new NdrcOfficialProvider(fetchImpl, 1000);
  const result = await provider.fetch({
    fund_code: "012414",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false,
    context: {
      fund_code: "012414",
      fund_name: "新能源产业优选混合",
      fund_type: "mixed",
      themes: ["新能源", "电力"]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "ndrc-official");
  assert.equal(result.source_name, "国家发展改革委官方政策 Provider");
  assert.equal(result.trust_level, "A");
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("成品油价格调整")));
  assert.ok(result.data?.news_summaries?.[0]?.includes("国家发展改革委"));
  assert.ok(result.warnings.some((warning) => warning.includes("不能直接补齐单只基金核心证据")));
  assert.match(result.raw_reference ?? "", /ndrc\.gov\.cn/);
});

test("NDRC official provider records explicit official-site failures", async () => {
  const fetchImpl = (async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const provider = new NdrcOfficialProvider(fetchImpl, 1000);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("国家发展改革委新闻发布页返回 HTTP 403")));
  assert.equal(result.raw_reference, "https://www.ndrc.gov.cn/xwdt/xwfb/");
});

test("Argus surfaces NDRC official provider failures in DataGapReport details", async () => {
  const fetchImpl = (async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const registry = new SourceRegistry({
    providers: [new NdrcOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("ndrc-official-failure-gap", "007951");
  const detail = dataPack.data_gap_report?.failed_source_details.find((source) => source.source_id === "ndrc-official");

  assert.ok(detail);
  assert.equal(detail.source_name, "国家发展改革委官方政策 Provider");
  assert.equal(detail.trust_level, "A");
  assert.match(detail.error ?? "", /HTTP 403/);
  assert.ok(detail.warnings.some((warning) => warning.includes("国家发展改革委新闻发布页返回 HTTP 403")));
  assert.equal(detail.raw_reference, "https://www.ndrc.gov.cn/xwdt/xwfb/");
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("policy_evidence"));
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("industry_news"));
});
