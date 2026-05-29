import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { OecdCliProvider, SourceRegistry } from "../src/dataSources/index.js";

const oecdCliCsv = [
  "STRUCTURE,STRUCTURE_ID,STRUCTURE_NAME,ACTION,REF_AREA,Reference area,FREQ,Frequency of observation,MEASURE,Measure,UNIT_MEASURE,Unit of measure,ACTIVITY,Economic activity,ADJUSTMENT,Adjustment,TRANSFORMATION,Transformation,TIME_HORIZ,Time horizon,METHODOLOGY,Calculation methodology,TIME_PERIOD,Time period,OBS_VALUE,Observation value,OBS_STATUS,Observation status,UNIT_MULT,Unit multiplier,DECIMALS,Decimals,BASE_PER,Base period",
  'DATAFLOW,OECD.SDD.STES:DSD_STES@DF_CLI(4.1),Composite leading indicators,I,USA,United States,M,Monthly,LI,Composite leading indicator (CLI),IX,Index,_Z,Not applicable,AA,Amplitude adjusted,IX,Index,_Z,Not applicable,H,OECD harmonised,2026-03,,100.7803,,A,Normal value,0,Units,2,Two,,',
  'DATAFLOW,OECD.SDD.STES:DSD_STES@DF_CLI(4.1),Composite leading indicators,I,USA,United States,M,Monthly,LI,Composite leading indicator (CLI),IX,Index,_Z,Not applicable,AA,Amplitude adjusted,IX,Index,_Z,Not applicable,H,OECD harmonised,2026-04,,100.8471,,A,Normal value,0,Units,2,Two,,',
  'DATAFLOW,OECD.SDD.STES:DSD_STES@DF_CLI(4.1),Composite leading indicators,I,CHN,China (People\'s Republic of),M,Monthly,LI,Composite leading indicator (CLI),IX,Index,_Z,Not applicable,AA,Amplitude adjusted,IX,Index,_Z,Not applicable,H,OECD harmonised,2026-04,,98.801,,A,Normal value,0,Units,2,Two,,'
].join("\n");

test("OecdCliProvider parses official SDMX CSV rows", () => {
  const parsed = OecdCliProvider.parseCsvResponse(
    oecdCliCsv,
    "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI/USA.M.LI.IX._Z.AA.IX._Z.H."
  );

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.refArea, "USA");
  assert.equal(parsed[0]?.indicatorId, "OECD_CLI_LI");
  assert.equal(parsed[0]?.indicatorName, "Composite leading indicator (CLI)");
  assert.equal(parsed[0]?.unit, "Index");
  assert.equal(parsed[1]?.date, "2026-04");
  assert.equal(parsed[1]?.value, 100.8471);
  assert.equal(parsed[2]?.countryName, "China (People's Republic of)");
});

test("OecdCliProvider returns official macro indicators without fund advice", async () => {
  const fetchImpl = (async () =>
    new Response(oecdCliCsv, {
      status: 200,
      headers: { "content-type": "application/vnd.sdmx.data+csv; charset=utf-8" }
    })) as typeof fetch;

  const result = await new OecdCliProvider(fetchImpl, 1000, [{ country: "USA", countryName: "United States" }], "2026-01").fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "oecd-data-api");
  assert.equal(result.source_type, "macro_data");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.macro_indicators?.length, 1);
  assert.equal(result.data?.macro_indicators?.[0]?.source_name, "OECD SDMX");
  assert.equal(result.data?.macro_indicators?.[0]?.value, 100.8471);
  assert.equal(result.data?.macro_indicators?.[0]?.date, "2026-04");
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.equal(result.data?.policy_signals, undefined);
  assert.equal(result.data?.news_summaries, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("OecdCliProvider fails explicitly when official API returns no usable observations", async () => {
  const fetchImpl = (async () =>
    new Response("NoRecordsFound", {
      status: 200,
      headers: { "content-type": "text/plain" }
    })) as typeof fetch;

  const result = await new OecdCliProvider(fetchImpl, 1000, [{ country: "EA20" }], "2026-01").fetch({
    fund_code: "007951",
    required_data: ["macro_data"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /no observations/i);
  assert.ok(result.warnings.some((warning) => warning.includes("未返回 EA20")));
});

test("Argus preserves OECD macro indicators in FundDataPack", async () => {
  const fetchImpl = (async () =>
    new Response(oecdCliCsv, {
      status: 200,
      headers: { "content-type": "application/vnd.sdmx.data+csv; charset=utf-8" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new OecdCliProvider(fetchImpl, 1000, [{ country: "USA", countryName: "United States" }], "2026-01")],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("oecd-cli-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.equal(dataPack.macro_indicators.length, 1);
  assert.equal(dataPack.macro_indicators[0]?.source_name, "OECD SDMX");
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "oecd-data-api" && source.record_count === 1));
});
