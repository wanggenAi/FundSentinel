import assert from "node:assert/strict";
import test from "node:test";
import { EastMoneyFundArchiveProvider } from "../src/dataSources/index.js";

const stockArchive = `
var apidata={ content:"<div><a href='http://fund.eastmoney.com/007951.html'>招商信用增强债券C</a><span>2026年1季度股票投资明细</span><span>截止至：<font>2026-03-31</font></span><table><tr><th>序号</th><th>股票代码</th><th>股票名称</th></tr><tr><td>1</td><td>600030</td><td>中信证券</td></tr><tr><td>2</td><td>300750</td><td>宁德时代</td></tr></table></div>",arryear:["2026"]};
`;

const bondArchive = `
var apidata={ content:"<div><a href='http://fund.eastmoney.com/007951.html'>招商信用增强债券C</a><span>2026年1季度债券投资明细</span><span>截止至：<font>2026-03-31</font></span><table><tr><th>序号</th><th>债券代码</th><th>债券名称</th></tr><tr><td>1</td><td>019740</td><td>23国债09</td></tr></table></div>",arryear:["2026"]};
`;

test("EastMoney archive parser extracts disclosed stock and bond holdings", () => {
  const stocks = EastMoneyFundArchiveProvider.parseArchiveData(stockArchive, "stock");
  const bonds = EastMoneyFundArchiveProvider.parseArchiveData(bondArchive, "bond");

  assert.equal(stocks.fundName, "招商信用增强债券C");
  assert.equal(stocks.asOfDate, "2026-03-31");
  assert.deepEqual(stocks.holdings, ["stock:600030:中信证券", "stock:300750:宁德时代"]);
  assert.deepEqual(bonds.holdings, ["bond:019740:23国债09"]);
});

test("EastMoney archive provider fetches holdings provenance with injected fetch", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) =>
    new Response(String(input).includes("type=jjcc") ? stockArchive : bondArchive, {
      status: 200,
      headers: { "content-type": "application/javascript" }
    })) as typeof fetch;

  const provider = new EastMoneyFundArchiveProvider(fetchImpl, 1000);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["holdings", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "eastmoney-fund-archive");
  assert.equal(result.data?.fund_name, "招商信用增强债券C");
  assert.equal(result.data?.holdings_as_of, "2026-03-31");
  assert.deepEqual(result.data?.portfolio_holdings, [
    "stock:600030:中信证券",
    "stock:300750:宁德时代",
    "bond:019740:23国债09"
  ]);
  assert.match(result.raw_reference ?? "", /fundf10\.eastmoney\.com/);
});
