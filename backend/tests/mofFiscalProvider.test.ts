import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { MofFiscalProvider, SourceRegistry } from "../src/dataSources/index.js";

const fiscalListHtml = `
<ul class="xwbd_lianbolistfrcon">
  <li><a href="http://gks.mof.gov.cn/tongjishuju/202605/t20260515_3989956.htm">2026年1-4月财政收支情况</a><span>2026-05-20</span></li>
  <li><a href="http://gks.mof.gov.cn/tongjishuju/202604/t20260424_3988324.htm">2026年一季度财政收支情况</a><span>2026-04-24</span></li>
  <li><a href="http://zhs.mof.gov.cn/zonghexinxi/202605/t20260525_3990465.htm">2026年4月份全国彩票销售情况</a><span>2026-05-26</span></li>
</ul>
`;

const fiscalArticleHtml = `
<html>
  <head>
    <meta name="ArticleTitle" content="2026年1-4月财政收支情况"/>
    <meta name="PubDate" content="2026-05-20 15:53:00"/>
  </head>
  <body>
    <div class="TRS_Editor">
      <p>一、全国一般公共预算收支情况</p>
      <p>（一）一般公共预算收入情况。</p>
      <p>1-4月，全国一般公共预算收入83404亿元，同比增长3.5%。其中，全国税收收入68097亿元，同比增长3.9%；非税收入15307亿元，同比增长1.6%。</p>
      <p>（二）一般公共预算支出情况。</p>
      <p>1—4月，全国一般公共预算支出94809亿元，同比增长1.3%。</p>
      <p>10.债务付息支出4283亿元，同比增长6.5%。</p>
      <p>二、全国政府性基金预算收支情况</p>
      <p>1-4月，全国政府性基金预算收入10208亿元，同比下降18.9%。其中，国有土地使用权出让收入6801亿元，同比下降27.2%。</p>
      <p>1-4月，全国政府性基金预算支出25431亿元，同比下降2.7%。</p>
    </div>
  </body>
</html>
`;

test("MofFiscalProvider parses latest fiscal revenue/expenditure article link", () => {
  const link = MofFiscalProvider.parseFiscalArticleLink(
    fiscalListHtml,
    "https://www.mof.gov.cn/zhengwuxinxi/redianzhuanti/quanguocaizhengshouzhiqingkuang/"
  );

  assert.equal(link?.title, "2026年1-4月财政收支情况");
  assert.equal(link?.url, "http://gks.mof.gov.cn/tongjishuju/202605/t20260515_3989956.htm");
  assert.equal(link?.published_at, "2026-05");
  assert.equal(link?.period, "2026-04");
});

test("MofFiscalProvider parses official fiscal article observations", () => {
  const parsed = MofFiscalProvider.parseFiscalArticle(
    fiscalArticleHtml,
    "2026-05-28T00:00:00.000Z",
    "http://gks.mof.gov.cn/tongjishuju/202605/t20260515_3989956.htm"
  );

  assert.equal(parsed.length, 16);
  assert.deepEqual(
    parsed.slice(0, 6).map((indicator) => [indicator.indicator_id, indicator.date, indicator.value, indicator.unit]),
    [
      ["CN.MOF.GENERAL_PUBLIC_BUDGET_REVENUE_CNY", "2026-04", 83404, "100 million yuan"],
      ["CN.MOF.GENERAL_PUBLIC_BUDGET_REVENUE_YOY", "2026-04", 3.5, "percent"],
      ["CN.MOF.TAX_REVENUE_CNY", "2026-04", 68097, "100 million yuan"],
      ["CN.MOF.TAX_REVENUE_YOY", "2026-04", 3.9, "percent"],
      ["CN.MOF.NON_TAX_REVENUE_CNY", "2026-04", 15307, "100 million yuan"],
      ["CN.MOF.NON_TAX_REVENUE_YOY", "2026-04", 1.6, "percent"]
    ]
  );
  assert.equal(parsed.find((indicator) => indicator.indicator_id === "CN.MOF.GOVERNMENT_FUND_BUDGET_REVENUE_YOY")?.value, -18.9);
  assert.equal(parsed.find((indicator) => indicator.indicator_id === "CN.MOF.LAND_USE_RIGHT_TRANSFER_REVENUE_YOY")?.value, -27.2);
  assert.equal(parsed[0]?.source_name, "Ministry of Finance of the People's Republic of China");
});

test("MofFiscalProvider returns official fiscal indicators without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("t20260515_3989956")) {
      return new Response(fiscalArticleHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(fiscalListHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new MofFiscalProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "mof-official");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.length, 16);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("MofFiscalProvider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("blocked", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new MofFiscalProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("财政部全国财政收支情况列表页返回 HTTP 403")));
  assert.match(result.raw_reference ?? "", /mof\.gov\.cn/);
});

test("Argus preserves MOF fiscal indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("t20260515_3989956")) {
      return new Response(fiscalArticleHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(fiscalListHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new MofFiscalProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("mof-fiscal-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 16);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "Ministry of Finance of the People's Republic of China");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "mof-official" && source.record_count === 16));
});
