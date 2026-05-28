import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { PbcMacroProvider, SourceRegistry } from "../src/dataSources/index.js";

const overviewHtml = `
<table border="0" cellpadding="0" cellspacing="0" class="a2015" width="100%">
  <tbody>
    <tr>
      <td align="left" height="55" valign="middle" width="470"><div class="titp20">货币供应量<br />Money Supply</div></td>
      <td align="center" height="55" valign="middle" width="40"><a href="/diaochatongjisi/attachDir/2026/01/2026011515582640595.htm" target="_blank">htm</a></td>
      <td align="center" height="55" valign="middle" width="40"><a href="/diaochatongjisi/attachDir/2026/01/2026011517191991857.xlsx">xls</a></td>
      <td align="center" class="nobr1" height="55" valign="middle" width="40"><a href="/diaochatongjisi/attachDir/2026/01/2026011517191958393.pdf" target="_blank">pdf</a></td>
    </tr>
  </tbody>
</table>
`;

const moneySupplyTableHtml = `
<table>
  <tr>
    <td colspan="3">项目 Item</td>
    <td>2025.10 </td>
    <td>2025.11 </td>
    <td>2025.12 </td>
  </tr>
  <tr>
    <td colspan="3">货币和准货币（M2）</td>
    <td rowspan="2">3351312.31 </td>
    <td rowspan="2">3369890.52 </td>
    <td rowspan="2">3402948.06 </td>
  </tr>
  <tr>
    <td colspan="3"><span style="mso-spacerun:yes">&nbsp;</span>Money &amp; Quasi-money</td>
  </tr>
  <tr>
    <td colspan="3">货币（M1）</td>
    <td rowspan="2">1119962.73 </td>
    <td rowspan="2">1128866.64 </td>
    <td rowspan="2">1155146.50 </td>
  </tr>
  <tr>
    <td colspan="3"><span style="mso-spacerun:yes">&nbsp;</span>Money</td>
  </tr>
  <tr>
    <td colspan="3">流通中货币（M0）</td>
    <td rowspan="2">135478.14 </td>
    <td rowspan="2">137369.38 </td>
    <td rowspan="2">141261.37 </td>
  </tr>
  <tr>
    <td colspan="3">Currency in Circulation</td>
  </tr>
</table>
`;

test("PbcMacroProvider parses official Money Supply links", () => {
  const link = PbcMacroProvider.parseMoneySupplyLink(
    overviewHtml,
    "https://www.pbc.gov.cn/diaochatongjisi/116219/116319/5570903/5570886/index.html"
  );

  assert.equal(link?.title, "Money Supply");
  assert.equal(link?.html_url, "https://www.pbc.gov.cn/diaochatongjisi/attachDir/2026/01/2026011515582640595.htm");
  assert.equal(link?.xls_url, "https://www.pbc.gov.cn/diaochatongjisi/attachDir/2026/01/2026011517191991857.xlsx");
  assert.equal(link?.pdf_url, "https://www.pbc.gov.cn/diaochatongjisi/attachDir/2026/01/2026011517191958393.pdf");
});

test("PbcMacroProvider parses official Money Supply HTML table observations", () => {
  const parsed = PbcMacroProvider.parseMoneySupplyTable(
    moneySupplyTableHtml,
    "2026-05-28T00:00:00.000Z",
    "https://www.pbc.gov.cn/diaochatongjisi/attachDir/2026/01/2026011515582640595.htm"
  );

  assert.equal(parsed.length, 9);
  assert.deepEqual(
    parsed.slice(0, 3).map((indicator) => [indicator.indicator_id, indicator.date, indicator.value]),
    [
      ["CN.PBC.M2", "2025-10", 3351312.31],
      ["CN.PBC.M2", "2025-11", 3369890.52],
      ["CN.PBC.M2", "2025-12", 3402948.06]
    ]
  );
  assert.equal(parsed[0]?.country_code, "CN");
  assert.equal(parsed[0]?.source_name, "People's Bank of China");
  assert.equal(parsed[0]?.unit, "100 million yuan");
  assert.equal(parsed.at(-1)?.indicator_id, "CN.PBC.M0");
});

test("PbcMacroProvider returns official liquidity indicators without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("2026011515582640595.htm")) {
      return new Response(moneySupplyTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(overviewHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const result = await new PbcMacroProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "pbc-official");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.length, 9);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("PbcMacroProvider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("blocked", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new PbcMacroProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("中国人民银行货币统计概览页返回 HTTP 403")));
  assert.match(result.raw_reference ?? "", /pbc\.gov\.cn/);
});

test("Argus preserves PBC macro indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("2026011515582640595.htm")) {
      return new Response(moneySupplyTableHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(overviewHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new PbcMacroProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("pbc-macro-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 9);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "People's Bank of China");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "pbc-official" && source.record_count === 9));
});
