import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { EurostatProvider, SourceRegistry } from "../src/dataSources/index.js";

const eurostatResponse = JSON.stringify({
  version: "2.0",
  class: "dataset",
  label: "Real GDP growth rate - volume",
  source: "ESTAT",
  updated: "2026-05-22T23:00:00+0200",
  value: { "0": 1.1, "1": 1.5 },
  id: ["freq", "unit", "na_item", "geo", "time"],
  size: [1, 1, 1, 1, 2],
  dimension: {
    geo: {
      label: "Geopolitical entity (reporting)",
      category: {
        index: { EU27_2020: 0 },
        label: { EU27_2020: "European Union - 27 countries (from 2020)" }
      }
    },
    time: {
      label: "Time",
      category: {
        index: { "2024": 0, "2025": 1 },
        label: { "2024": "2024", "2025": "2025" }
      }
    }
  }
});

const eurostatSeries = [
  {
    dataset: "tec00115",
    indicator_id: "EU_REAL_GDP_GROWTH",
    indicator_name: "Real GDP growth rate - volume",
    unit: "percent change on previous period",
    geo: "EU27_2020",
    query: {
      geo: "EU27_2020",
      unit: "CLV_PCH_PRE",
      na_item: "B1GQ"
    }
  }
];

test("EurostatProvider parses official JSON-stat observations", () => {
  const parsed = EurostatProvider.parseJsonStatResponse(
    eurostatResponse,
    eurostatSeries[0],
    "2026-05-28T00:00:00.000Z",
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/tec00115"
  );

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.country_code, "EU27_2020");
  assert.equal(parsed[0]?.country_name, "European Union - 27 countries (from 2020)");
  assert.equal(parsed[0]?.indicator_id, "EU_REAL_GDP_GROWTH");
  assert.equal(parsed[0]?.date, "2025");
  assert.equal(parsed[0]?.value, 1.5);
  assert.equal(parsed[0]?.source_name, "Eurostat");
});

test("EurostatProvider returns official macro indicators without fund advice", async () => {
  let requestedUrl = "";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(eurostatResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const result = await new EurostatProvider(fetchImpl, 1000, eurostatSeries, ["2024", "2025"]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "eurostat-api");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.match(requestedUrl, /tec00115/);
  assert.match(requestedUrl, /geo=EU27_2020/);
  assert.equal(result.data?.macro_indicators?.[0]?.value, 1.5);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("EurostatProvider fails explicitly on official API error payloads", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: [{ status: 400, label: "INVALID_QUERY_DIMENSION" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new EurostatProvider(fetchImpl, 1000, eurostatSeries, ["2024", "2025"]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /INVALID_QUERY_DIMENSION/);
  assert.ok(result.warnings.some((warning) => warning.includes("macro_data")));
});

test("Argus preserves Eurostat macro indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(eurostatResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new EurostatProvider(fetchImpl, 1000, eurostatSeries, ["2024", "2025"])],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("eurostat-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 1);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "Eurostat");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "eurostat-api" && source.record_count === 1));
});
