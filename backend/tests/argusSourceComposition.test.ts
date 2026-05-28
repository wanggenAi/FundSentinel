import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import {
  EastMoneyFundProvider,
  EastMoneyNavHistoryProvider,
  GovCnPolicyProvider,
  ManualCsvProvider,
  SourceRegistry,
  WorldBankMacroProvider
} from "../src/dataSources/index.js";

const eastMoneyText = `
var fS_name = "招商信用增强债券C";var fS_code = "007951";
var Data_netWorthTrend = [
  {"x":1779840000000,"y":1.0801,"equityReturn":-0.19,"unitMoney":""},
  {"x":1779926400000,"y":1.0799,"equityReturn":-0.02,"unitMoney":""}
];
`;

const navHistoryJson = JSON.stringify({
  Data: {
    LSJZList: [
      { FSRQ: "2026-05-28", DWJZ: "1.0799", JZZZL: "-0.02" },
      { FSRQ: "2026-05-27", DWJZ: "1.0801", JZZZL: "-0.19" }
    ]
  }
});

const govPolicyJson = JSON.stringify([
  {
    TITLE: "国务院关于稳定经济增长的政策文件",
    URL: "https://www.gov.cn/zhengce/content/test.htm",
    DOCRELPUBTIME: "2026-05-20"
  }
]);

const worldBankJson = JSON.stringify([
  { page: 1, pages: 1, per_page: 1, total: 1 },
  [
    {
      indicator: { id: "NY.GDP.MKTP.KD.ZG", value: "GDP growth (annual %)" },
      country: { id: "CN", value: "China" },
      date: "2025",
      value: 5.1
    }
  ]
]);

test("Argus source composition separates authoritative, aggregator, manual, and macro sources", async () => {
  const registry = new SourceRegistry({
    providers: [
      new EastMoneyFundProvider(
        (async () =>
          new Response(eastMoneyText, {
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
      ),
      new GovCnPolicyProvider(
        (async () =>
          new Response(govPolicyJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000
      ),
      new WorldBankMacroProvider(
        (async () =>
          new Response(worldBankJson, {
            status: 200,
            headers: { "content-type": "application/json" }
          })) as typeof fetch,
        1000,
        ["CN"],
        [{ id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" }]
      )
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack, result } = await new ArgusAgent(registry).prepareDataPack("source-composition", "007951");
  const composition = dataPack.data_quality_report.source_composition;

  assert.ok(composition.aggregator.includes("eastmoney-fund"));
  assert.ok(composition.aggregator.includes("eastmoney-nav-history"));
  assert.ok(composition.authoritative.includes("gov-cn-policy"));
  assert.ok(composition.macro.includes("world-bank-api"));
  assert.equal(composition.official_core_coverage.current_nav, false);
  assert.equal(composition.official_core_coverage.nav_history, false);
  assert.equal(dataPack.data_quality_report.aggregator_source_count, 2);
  assert.equal(dataPack.data_quality_report.macro_source_count, 1);
  assert.ok(result.evidence.some((item) => item.source_name.includes("EastMoney") && item.source_type === "industry_data"));
});

test("Argus source composition recognizes manual import separately from aggregator sources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-source-composition-"));
  try {
    await writeFile(
      path.join(dir, "007951.csv"),
      [
        "fund_code,date,nav,fund_name,fund_type",
        "007951,2026-05-27,1.0801,招商信用增强债券C,债券型",
        "007951,2026-05-28,1.0799,招商信用增强债券C,债券型"
      ].join("\n")
    );

    const registry = new SourceRegistry({
      providers: [new ManualCsvProvider(dir)],
      cacheTtlMs: 0,
      retryCount: 0
    });
    const { dataPack } = await new ArgusAgent(registry).prepareDataPack("manual-source-composition", "007951");
    const composition = dataPack.data_quality_report.source_composition;

    assert.ok(composition.manual.includes("manual-csv-import"));
    assert.equal(composition.aggregator.length, 0);
    assert.equal(dataPack.data_quality_report.manual_source_count, 1);
    assert.equal(composition.official_core_coverage.current_nav, false);
    assert.equal(composition.official_core_coverage.nav_history, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
