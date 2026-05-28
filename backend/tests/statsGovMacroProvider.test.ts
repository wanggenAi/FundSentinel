import assert from "node:assert/strict";
import test from "node:test";
import { StatsGovMacroProvider } from "../src/dataSources/index.js";

const statsGovResponse = JSON.stringify({
  returncode: 200,
  returndata: {
    datanodes: [
      {
        data: { data: 1349084.0, strdata: "1349084.0", hasdata: true },
        wds: [
          { wdcode: "zb", valuecode: "A020101" },
          { wdcode: "sj", valuecode: "2024" }
        ]
      },
      {
        data: { data: 1294272.0, strdata: "1294272.0", hasdata: true },
        wds: [
          { wdcode: "zb", valuecode: "A020101" },
          { wdcode: "sj", valuecode: "2023" }
        ]
      }
    ],
    wdnodes: [
      {
        wdcode: "sj",
        nodes: [
          { code: "2024", name: "2024年" },
          { code: "2023", name: "2023年" }
        ]
      }
    ]
  }
});

test("StatsGovMacroProvider parses official National Data observations", () => {
  const parsed = StatsGovMacroProvider.parseIndicatorResponse(
    statsGovResponse,
    { id: "A020101", name: "GDP current-price total", unit: "100 million CNY" },
    "2026-05-28T00:00:00.000Z",
    "https://data.stats.gov.cn/easyquery.htm?m=QueryData"
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.country_code, "CN");
  assert.equal(parsed[0]?.indicator_id, "A020101");
  assert.equal(parsed[0]?.indicator_name, "GDP current-price total");
  assert.equal(parsed[0]?.value, 1349084);
  assert.equal(parsed[0]?.date, "2024");
  assert.equal(parsed[0]?.source_name, "National Bureau of Statistics of China");
});

test("StatsGovMacroProvider returns macro indicators without policy/news masquerading", async () => {
  const fetchImpl = (async () =>
    new Response(statsGovResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new StatsGovMacroProvider(fetchImpl, 1000, [
    { id: "A020101", name: "GDP current-price total", unit: "100 million CNY" }
  ]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "stats-gov-cn");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.[0]?.value, 1349084);
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
});

test("StatsGovMacroProvider surfaces WAF block as explicit failure", async () => {
  const fetchImpl = (async () =>
    new Response("<html><title>403 Forbidden</title><center>reason:UrlACL</center></html>", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new StatsGovMacroProvider(fetchImpl, 1000, [
    { id: "A020101", name: "GDP current-price total", unit: "100 million CNY" }
  ]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("官方宏观数据缺口")));
});
