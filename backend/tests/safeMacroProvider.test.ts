import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { SafeMacroProvider, SourceRegistry } from "../src/dataSources/index.js";

const listHtml = `
<ul>
  <li><a href="/safe/2026/0206/27116.html" title="官方储备资产（2026）" target="_blank">官方储备资产（2026）</a></li>
  <li><a href="/safe/2025/0206/27115.html" title="官方储备资产（2025）" target="_blank">官方储备资产（2025）</a></li>
  <li><a href="/safe/2026/0228/27175.html" title="国际储备与外币流动性数据模板（2026年）" target="_blank">国际储备与外币流动性数据模板（2026年）</a></li>
</ul>
`;

const reserveTableHtml = `
<table>
  <tr>
    <td>项目 Item</td>
    <td colspan="2">2026.01</td>
    <td colspan="2">2026.02</td>
    <td colspan="2">2026.03</td>
    <td colspan="2">2026.04</td>
  </tr>
  <tr>
    <td></td>
    <td>亿美元<br/>100million USD</td>
    <td>亿SDR<br/>100million SDR</td>
    <td>亿美元<br/>100million USD</td>
    <td>亿SDR<br/>100million SDR</td>
    <td>亿美元<br/>100million USD</td>
    <td>亿SDR<br/>100million SDR</td>
    <td>亿美元<br/>100million USD</td>
    <td>亿SDR<br/>100million SDR</td>
  </tr>
  <tr>
    <td>1. 外汇储备<br/>Foreign currency reserves</td>
    <td>33990.78</td>
    <td>24597.67</td>
    <td>34278.07</td>
    <td>24933.77</td>
    <td>33421.23</td>
    <td>24639.84</td>
    <td>34105.47</td>
    <td>24857.91</td>
  </tr>
  <tr>
    <td>2. 基金组织储备头寸<br/>IMF reserve position</td>
    <td>111.98</td>
    <td>81.04</td>
    <td>111.40</td>
    <td>81.03</td>
    <td>109.03</td>
    <td>80.38</td>
    <td>109.38</td>
    <td>79.72</td>
  </tr>
  <tr>
    <td>3. 特别提款权<br/>SDRs</td>
    <td>562.34</td>
    <td>406.94</td>
    <td>560.93</td>
    <td>408.02</td>
    <td>553.43</td>
    <td>408.02</td>
    <td>560.33</td>
    <td>408.40</td>
  </tr>
  <tr>
    <td>4. 黄金<br/>Gold</td>
    <td>3695.82</td>
    <td>2674.51</td>
    <td>3875.88</td>
    <td>2819.30</td>
    <td>3427.63</td>
    <td>2527.02</td>
    <td>3441.72</td>
    <td>2508.51</td>
  </tr>
  <tr>
    <td>5. 其他储备资产<br/>Other reserve assets</td>
    <td>1.89</td>
    <td>1.37</td>
    <td>0.65</td>
    <td>0.47</td>
    <td>-0.09</td>
    <td>-0.07</td>
    <td>0.27</td>
    <td>0.20</td>
  </tr>
  <tr>
    <td>合计<br/>Total</td>
    <td>38362.81</td>
    <td>27761.53</td>
    <td>38826.93</td>
    <td>28242.59</td>
    <td>37511.23</td>
    <td>27655.19</td>
    <td>38217.17</td>
    <td>27854.74</td>
  </tr>
</table>
`;

test("SafeMacroProvider parses official reserve-assets list link", () => {
  const link = SafeMacroProvider.parseOfficialReserveLink(listHtml, "https://www.safe.gov.cn/safe/gfcbzc/index.html");

  assert.equal(link?.title, "官方储备资产（2026）");
  assert.equal(link?.html_url, "https://www.safe.gov.cn/safe/2026/0206/27116.html");
  assert.equal(link?.year, 2026);
});

test("SafeMacroProvider parses official reserve-assets HTML table observations", () => {
  const parsed = SafeMacroProvider.parseOfficialReserveTable(
    reserveTableHtml,
    "2026-05-28T00:00:00.000Z",
    "https://www.safe.gov.cn/safe/2026/0206/27116.html"
  );

  assert.equal(parsed.length, 24);
  assert.deepEqual(
    parsed.slice(0, 4).map((indicator) => [indicator.indicator_id, indicator.date, indicator.value]),
    [
      ["CN.SAFE.FX_RESERVES_USD", "2026-01", 33990.78],
      ["CN.SAFE.FX_RESERVES_USD", "2026-02", 34278.07],
      ["CN.SAFE.FX_RESERVES_USD", "2026-03", 33421.23],
      ["CN.SAFE.FX_RESERVES_USD", "2026-04", 34105.47]
    ]
  );
  assert.equal(parsed[0]?.country_code, "CN");
  assert.equal(parsed[0]?.source_name, "State Administration of Foreign Exchange");
  assert.equal(parsed[0]?.unit, "100 million USD");
  assert.equal(parsed.at(-1)?.indicator_id, "CN.SAFE.TOTAL_RESERVE_ASSETS_USD");
  assert.equal(parsed.at(-1)?.value, 38217.17);
});

test("SafeMacroProvider returns official reserve indicators without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/safe/2026/0206/27116.html")) {
      return new Response(reserveTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(listHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new SafeMacroProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "safe-official");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.length, 24);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("SafeMacroProvider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("blocked", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new SafeMacroProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("国家外汇管理局官方储备资产列表页返回 HTTP 403")));
  assert.match(result.raw_reference ?? "", /safe\.gov\.cn/);
});

test("Argus preserves SAFE macro indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/safe/2026/0206/27116.html")) {
      return new Response(reserveTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(listHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new SafeMacroProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("safe-macro-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 24);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "State Administration of Foreign Exchange");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "safe-official" && source.record_count === 24));
});
