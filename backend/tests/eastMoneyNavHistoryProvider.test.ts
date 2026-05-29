import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { EastMoneyFundProvider, EastMoneyNavHistoryProvider, SourceRegistry } from "../src/dataSources/index.js";

const navHistoryJson = JSON.stringify({
  Data: {
    LSJZList: [
      { FSRQ: "2026-05-28", DWJZ: "1.0799", LJJZ: "1.3281", JZZZL: "-0.02", SGZT: "限制大额申购", SHZT: "开放赎回" },
      { FSRQ: "2026-05-27", DWJZ: "1.0801", LJJZ: "1.3283", JZZZL: "-0.19", SGZT: "限制大额申购", SHZT: "开放赎回" },
      { FSRQ: "2026-05-26", DWJZ: "1.0822", LJJZ: "1.3304", JZZZL: "0.06", SGZT: "限制大额申购", SHZT: "开放赎回" }
    ],
    TotalCount: 3,
    PageSize: 20,
    PageIndex: 1
  },
  ErrCode: 0,
  ErrMsg: null
});

const pingzhongText = `
var fS_name = "招商信用增强债券C";var fS_code = "007951";
var Data_netWorthTrend = [
  {"x":1764000000000,"y":1.0500,"equityReturn":0.10,"unitMoney":""},
  {"x":1764086400000,"y":1.0510,"equityReturn":0.10,"unitMoney":""}
];
`;

test("EastMoneyNavHistoryProvider parses detailed NAV rows", () => {
  const parsed = EastMoneyNavHistoryProvider.parseNavHistoryResponse(navHistoryJson, "007951");

  assert.equal(parsed.fund_code, "007951");
  assert.equal(parsed.current_nav, 1.0799);
  assert.equal(parsed.daily_return, -0.0002);
  assert.deepEqual(parsed.nav_history, [1.0822, 1.0801, 1.0799]);
  assert.deepEqual(parsed.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
});

test("EastMoneyNavHistoryProvider fetches detailed NAV provenance", async () => {
  const fetchImpl = async () =>
    new Response(navHistoryJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  const result = await new EastMoneyNavHistoryProvider(fetchImpl as typeof fetch, 1000).fetch({
    fund_code: "007951",
    required_data: ["current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "eastmoney-nav-history");
  assert.equal(result.data?.current_nav, 1.0799);
  assert.equal(result.data?.nav_history_dates?.at(-1), "2026-05-28");
  assert.match(result.raw_reference ?? "", /api\.fund\.eastmoney\.com/);
});

test("Argus prefers fresher detailed NAV rows and records unmatched older NAV source", async () => {
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyFundProvider(
        (async () =>
          new Response(pingzhongText, {
            status: 200,
            headers: { "content-type": "application/javascript" }
          })) as typeof fetch,
        1000
      ),
      new EastMoneyNavHistoryProvider(
        (async () =>
          new Response(navHistoryJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("nav-cross-check", "007951");

  assert.equal(dataPack.current_nav, 1.0799);
  assert.equal(dataPack.daily_return, -0.0002);
  assert.deepEqual(dataPack.nav_history, [1.0822, 1.0801, 1.0799]);
  assert.deepEqual(dataPack.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "eastmoney-nav-history" && source.record_count === 3));
  assert.equal(dataPack.data_quality_report.nav_consistency_report.status, "not_checked");
  assert.equal(dataPack.data_quality_report.nav_consistency_report.checked_source_count, 2);
  assert.deepEqual(dataPack.data_quality_report.nav_consistency_report.not_checked_reasons, ["fewer_than_two_same_date_nav_sources"]);
});

test("Argus records when NAV consistency cannot cross-check a single source", async () => {
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyNavHistoryProvider(
        (async () =>
          new Response(navHistoryJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("nav-single-source", "007951");

  assert.equal(dataPack.data_quality_report.nav_consistency_report.status, "not_checked");
  assert.equal(dataPack.data_quality_report.nav_consistency_report.checked_source_count, 1);
  assert.deepEqual(dataPack.data_quality_report.nav_consistency_report.not_checked_reasons, ["fewer_than_two_current_nav_sources"]);
});

test("Argus records when NAV providers are not comparable on the same date", async () => {
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyFundProvider(
        (async () =>
          new Response(pingzhongText, {
            status: 200,
            headers: { "content-type": "application/javascript" }
          })) as typeof fetch,
        1000
      ),
      new EastMoneyNavHistoryProvider(
        (async () =>
          new Response(navHistoryJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("nav-mismatched-dates", "007951");

  assert.equal(dataPack.data_quality_report.nav_consistency_report.status, "not_checked");
  assert.equal(dataPack.data_quality_report.nav_consistency_report.checked_source_count, 2);
  assert.deepEqual(dataPack.data_quality_report.nav_consistency_report.not_checked_reasons, ["fewer_than_two_same_date_nav_sources"]);
});

test("Argus downgrades strong conclusion when NAV providers conflict", async () => {
  const conflictingPingzhongText = `
var fS_name = "招商信用增强债券C";var fS_code = "007951";
var Data_netWorthTrend = [
  {"x":1779840000000,"y":1.0500,"equityReturn":0.10,"unitMoney":""},
  {"x":1779926400000,"y":1.0500,"equityReturn":0.10,"unitMoney":""}
];
`;
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyFundProvider(
        (async () =>
          new Response(conflictingPingzhongText, {
            status: 200,
            headers: { "content-type": "application/javascript" }
          })) as typeof fetch,
        1000
      ),
      new EastMoneyNavHistoryProvider(
        (async () =>
          new Response(navHistoryJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("nav-conflict", "007951");

  assert.equal(dataPack.data_quality_report.nav_consistency_report.status, "conflict");
  assert.ok(dataPack.data_quality_report.nav_consistency_report.conflicts.some((conflict) => conflict.includes("eastmoney-fund")));
  assert.deepEqual(dataPack.data_quality_report.nav_consistency_report.not_checked_reasons, []);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.ok(dataPack.data_quality_report.missing_auxiliary_fields.includes("nav_consistency"));
  assert.ok(dataPack.data_quality_report.warnings.some((warning) => warning.includes("核心净值跨源校验冲突")));
});
