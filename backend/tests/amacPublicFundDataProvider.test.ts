import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { AmacPublicFundDataProvider, SourceRegistry } from "../src/dataSources/index.js";

const amacPublicFundHtml = `
<html>
  <body>
    <div class="mod-news">
      <div>
        <span></span>
        <a href="./202605/P020260527642499680112.pdf">公募基金市场数据（2026年4月）<i>05-27</i></a>
      </div>
      <div>
        <span></span>
        <a href="./202604/P020260422599009744026.pdf">公募基金市场数据（2026年3月）<i>04-22</i></a>
      </div>
    </div>
    <ul>
      <li>
        <span></span>
        <a href="./202605/P020260527642499680112.pdf">公募基金市场数据（2026年4月）</a>
        <i> 2026-05-27 </i>
      </li>
      <li>
        <span></span>
        <a href="./202604/P020260422599009744026.pdf">公募基金市场数据（2026年3月）</a>
        <i> 2026-04-22 </i>
      </li>
      <li>
        <span></span>
        <a href="./202603/P020260326626512708384.pdf">公募基金市场数据（2026年2月）</a>
        <i> 2026-03-25 </i>
      </li>
    </ul>
  </body>
</html>
`;

test("AmacPublicFundDataProvider parses official monthly public-fund market-data PDF references", () => {
  const reports = AmacPublicFundDataProvider.parseReportList(amacPublicFundHtml, "https://www.amac.org.cn/sjtj/tjbg/gmjj/");

  assert.equal(reports.length, 3);
  assert.equal(reports[0]?.title, "公募基金市场数据（2026年4月）");
  assert.equal(reports[0]?.period, "2026-04");
  assert.equal(reports[0]?.published_at, "2026-05-27");
  assert.equal(reports[0]?.url, "https://www.amac.org.cn/sjtj/tjbg/gmjj/202605/P020260527642499680112.pdf");
  assert.equal(reports[0]?.report_type, "public_fund_market_data");
});

test("AmacPublicFundDataProvider returns official industry evidence without fund advice", async () => {
  const fetchImpl = (async () =>
    new Response(amacPublicFundHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new AmacPublicFundDataProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "amac-public-fund-data");
  assert.equal(result.source_type, "policy");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_code, "007951");
  assert.equal(result.data?.current_nav, undefined);
  assert.equal(result.data?.nav_history, undefined);
  assert.equal(result.data?.fund_report_documents, undefined);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("2026-05-27 基金业协会公募基金市场数据 2026-04")));
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("中国证券投资基金业协会/公募基金统计")));
  assert.match(result.raw_reference ?? "", /amac\.org\.cn\/sjtj\/tjbg\/gmjj/);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资建议或买卖结论")));
  assert.doesNotMatch(JSON.stringify(result), /trial_buy|staged_buy|\b(buy|sell|position)\b/i);
});

test("AmacPublicFundDataProvider fails explicitly when official list is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("blocked", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new AmacPublicFundDataProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("基金业协会公募基金统计报告页面返回 HTTP 403")));
});

test("Argus preserves AMAC industry evidence without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(amacPublicFundHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new AmacPublicFundDataProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("amac-public-fund-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.ok(dataPack.policy_signals.some((signal) => signal.includes("基金业协会公募基金市场数据")));
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("公募基金统计")));
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("fund_meta"));
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("current_nav"));
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("nav_history"));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "amac-public-fund-data" && source.record_count === 3));
});
