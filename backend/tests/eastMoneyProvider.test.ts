import assert from "node:assert/strict";
import test from "node:test";
import { EastMoneyFundProvider } from "../src/dataSources/index.js";

const sampleText = `
var fS_name = "招商信用增强债券C";var fS_code = "007951";
var syl_1n="6.8";var syl_6y="3.03";var syl_3y="-0.68";var syl_1y="-0.32";
var stockCodesNew =["1.600030","0.300750"];
var zqCodes = "bond-a,bond-b";
var Data_netWorthTrend = [
  {"x":1764259200000,"y":1.217,"equityReturn":0.10,"unitMoney":""},
  {"x":1764518400000,"y":1.219,"equityReturn":0.16,"unitMoney":""}
];
`;

test("EastMoney parser extracts real fund fields from public page JavaScript", () => {
  const parsed = EastMoneyFundProvider.parsePingzhongData(sampleText);

  assert.equal(parsed.fund_code, "007951");
  assert.equal(parsed.fund_name, "招商信用增强债券C");
  assert.equal(parsed.fund_type, "bond");
  assert.equal(parsed.current_nav, 1.219);
  assert.deepEqual(parsed.nav_history, [1.217, 1.219]);
  assert.equal(parsed.nav_history_dates?.length, 2);
  assert.equal(parsed.daily_return, 0.0016);
  assert.equal(parsed.stage_returns?.["1y"], 0.068);
  assert.ok(parsed.portfolio_holdings?.includes("stock:1.600030"));
  assert.ok(parsed.portfolio_holdings?.includes("bond:bond-a"));
});

test("EastMoney provider fetches and returns provenance with injected fetch", async () => {
  const fetchImpl = async () =>
    new Response(sampleText, {
      status: 200,
      headers: { "content-type": "application/javascript" }
    });
  const provider = new EastMoneyFundProvider(fetchImpl as typeof fetch, 1000);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "eastmoney-fund");
  assert.equal(result.data?.fund_code, "007951");
  assert.equal(result.data?.current_nav, 1.219);
  assert.match(result.raw_reference ?? "", /fund\.eastmoney\.com/);
  assert.ok(result.warnings.some((warning) => warning.includes("公开页面解析")));
});
