import assert from "node:assert/strict";
import test from "node:test";
import { SourceRegistry, WorldBankMacroProvider } from "../src/dataSources/index.js";
import { ArgusAgent } from "../src/agents/index.js";

const worldBankResponse = JSON.stringify([
  { page: 1, pages: 1, per_page: 1, total: 1 },
  [
    {
      indicator: { id: "NY.GDP.MKTP.KD.ZG", value: "GDP growth (annual %)" },
      country: { id: "CN", value: "China" },
      date: "2025",
      value: 5.1
    },
    {
      indicator: { id: "NY.GDP.MKTP.KD.ZG", value: "GDP growth (annual %)" },
      country: { id: "CN", value: "China" },
      date: "2024",
      value: 4.9
    }
  ]
]);

test("WorldBankMacroProvider parses official indicator observations", () => {
  const parsed = WorldBankMacroProvider.parseIndicatorResponse(
    worldBankResponse,
    { id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" },
    "2026-05-28T00:00:00.000Z",
    "https://api.worldbank.org/v2/country/CN/indicator/NY.GDP.MKTP.KD.ZG?format=json"
  );

  assert.equal(parsed?.length, 2);
  assert.equal(parsed?.[0]?.country_code, "CN");
  assert.equal(parsed?.[0]?.indicator_id, "NY.GDP.MKTP.KD.ZG");
  assert.equal(parsed?.[0]?.value, 5.1);
  assert.equal(parsed?.[0]?.source_name, "World Bank Open Data");
});

test("WorldBankMacroProvider returns macro indicators without fund advice", async () => {
  const fetchImpl = (async () =>
    new Response(worldBankResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new WorldBankMacroProvider(fetchImpl, 1000, ["CN"], [
    { id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" }
  ]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "world-bank-api");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.[0]?.value, 5.1);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("Argus preserves World Bank macro indicators in FundDataPack", async () => {
  const fetchImpl = (async () =>
    new Response(worldBankResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [
      new WorldBankMacroProvider(fetchImpl, 1000, ["CN"], [
        { id: "NY.GDP.MKTP.KD.ZG", name: "GDP growth (annual %)", unit: "percent" }
      ])
    ],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("world-bank-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 1);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "World Bank Open Data");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "world-bank-api" && source.record_count === 1));
});
