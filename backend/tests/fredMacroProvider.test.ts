import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { FredMacroProvider, SourceRegistry } from "../src/dataSources/index.js";

const fredResponse = JSON.stringify({
  observations: [
    { date: "2026-05-27", value: "4.33" },
    { date: "2026-05-26", value: "." },
    { date: "2026-05-25", value: "4.34" }
  ]
});

const fredSeries = [{ id: "FEDFUNDS", name: "Effective Federal Funds Rate", unit: "percent" }];

test("FredMacroProvider parses official observation payloads", () => {
  const parsed = FredMacroProvider.parseObservationsResponse(
    fredResponse,
    fredSeries[0],
    "2026-05-28T00:00:00.000Z",
    "https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=***&file_type=json"
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.country_code, "US");
  assert.equal(parsed[0]?.indicator_id, "FEDFUNDS");
  assert.equal(parsed[0]?.value, 4.33);
  assert.equal(parsed[0]?.source_name, "FRED Federal Reserve Economic Data");
});

test("FredMacroProvider fails explicitly when API key is missing", async () => {
  const fetchImpl = (async () => {
    throw new Error("should not fetch without key");
  }) as typeof fetch;

  const result = await new FredMacroProvider(fetchImpl, 1000, "", fredSeries).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.equal(result.source_id, "fred-official");
  assert.equal(result.is_demo, false);
  assert.equal(result.error, "Missing FRED API key");
  assert.ok(result.warnings.some((warning) => warning.includes("FRED_API_KEY")));
});

test("FredMacroProvider returns official macro indicators without leaking key or advice", async () => {
  let requestedUrl = "";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(fredResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const result = await new FredMacroProvider(fetchImpl, 1000, "secret-test-key", fredSeries).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "fred-official");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.[0]?.value, 4.33);
  assert.match(requestedUrl, /api_key=secret-test-key/);
  assert.doesNotMatch(result.raw_reference ?? "", /secret-test-key/);
  assert.doesNotMatch(result.data?.macro_indicators?.[0]?.source_url ?? "", /secret-test-key/);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("Argus preserves FRED macro indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(fredResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new FredMacroProvider(fetchImpl, 1000, "secret-test-key", fredSeries)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("fred-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 1);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "FRED Federal Reserve Economic Data");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "fred-official" && source.record_count === 1));
});
