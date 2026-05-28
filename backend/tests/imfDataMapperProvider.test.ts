import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { ImfDataMapperProvider, SourceRegistry } from "../src/dataSources/index.js";

const imfResponse = JSON.stringify({
  indicators: {
    NGDP_RPCH: {
      label: "Real GDP growth",
      unit: "Annual percent change",
      source: "World Economic Outlook (April 2026)",
      dataset: "WEO",
      "last-modified": "2026-04-08 16:07:34"
    }
  },
  values: {
    NGDP_RPCH: {
      USA: { "2024": 2.8, "2025": 1.8, "2026": 1.7 },
      CHN: { "2024": 5, "2025": 4, "2026": 4 },
      SDN: { "2024": -23.4, "2025": 3.2, "2026": 0.7 }
    }
  }
});

const imfIndicator = [{ id: "NGDP_RPCH", name: "Real GDP growth", unit: "Annual percent change" }];

test("ImfDataMapperProvider parses official WEO macro observations and filters requested countries", () => {
  const parsed = ImfDataMapperProvider.parseIndicatorResponse(
    imfResponse,
    imfIndicator[0],
    ["USA", "CHN"],
    "2026-05-28T00:00:00.000Z",
    "https://www.imf.org/external/datamapper/api/v2/NGDP_RPCH/USA/CHN?periods=2024,2025,2026"
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.country_code, "USA");
  assert.equal(parsed[0]?.country_name, "United States");
  assert.equal(parsed[0]?.indicator_id, "NGDP_RPCH");
  assert.equal(parsed[0]?.date, "2026");
  assert.equal(parsed[0]?.value, 1.7);
  assert.equal(parsed[0]?.source_name, "IMF DataMapper");
  assert.ok(parsed.every((indicator) => indicator.country_code !== "SDN"));
});

test("ImfDataMapperProvider returns official macro indicators without fund advice", async () => {
  let requestedUrl = "";
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return new Response(imfResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const result = await new ImfDataMapperProvider(fetchImpl, 1000, ["USA", "CHN"], imfIndicator, ["2024", "2025", "2026"]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "imf-data-api");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.match(requestedUrl, /NGDP_RPCH\/USA\/CHN/);
  assert.equal(result.data?.macro_indicators?.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("ImfDataMapperProvider fails explicitly when the official API returns no usable observations", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ values: { NGDP_RPCH: { USA: { "2026": null } } } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new ImfDataMapperProvider(fetchImpl, 1000, ["USA"], imfIndicator, ["2026"]).fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /No usable|no usable/);
  assert.ok(result.warnings.some((warning) => warning.includes("macro_data")));
});

test("Argus preserves IMF macro indicators without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(imfResponse, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new ImfDataMapperProvider(fetchImpl, 1000, ["USA"], imfIndicator, ["2024", "2025", "2026"])],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("imf-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 1);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "IMF DataMapper");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "imf-data-api" && source.record_count === 1));
});
