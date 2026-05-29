import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ManualCsvProvider, SourceRegistry } from "../src/dataSources/index.js";
import { ArgusAgent } from "../src/agents/index.js";

test("ManualCsvProvider parses verified CSV rows into a real data payload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-manual-csv-"));
  try {
    await writeFile(
      path.join(dir, "007951.csv"),
      [
        "fund_code,date,nav,fund_name,fund_type,daily_return,holding,theme",
        "007951,2026-05-26,1.012,招商信用增强债券C,债券型,0.10,国债,债券",
        "007951,2026-05-27,1.015,招商信用增强债券C,债券型,0.30,政策性金融债,债券",
        "007951,2026-05-28,1.018,招商信用增强债券C,债券型,0.29,信用债,债券"
      ].join("\n")
    );

    const result = await new ManualCsvProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_meta", "current_nav", "nav_history"],
      demo_mode: false
    });

    assert.equal(result.success, true);
    assert.equal(result.is_demo, false);
    assert.equal(result.source_type, "manual_import");
    assert.equal(result.data?.fund_name, "招商信用增强债券C");
    assert.equal(result.data?.current_nav, 1.018);
    assert.deepEqual(result.data?.nav_history, [1.012, 1.015, 1.018]);
    assert.deepEqual(result.data?.portfolio_holdings, ["国债", "政策性金融债", "信用债"]);
    assert.equal(result.raw_reference, path.join(dir, "007951.csv"));
    assert.equal(result.data?.manual_import_audit?.row_count, 3);
    assert.equal(result.data?.manual_import_audit?.date_start, "2026-05-26");
    assert.equal(result.data?.manual_import_audit?.date_end, "2026-05-28");
    assert.equal(result.data?.manual_import_audit?.latest_date, "2026-05-28");
    assert.equal(result.data?.manual_import_audit?.file_path, path.join(dir, "007951.csv"));
    assert.equal(result.data?.manual_import_audit?.file_sha256.length, 64);
    assert.ok((result.data?.manual_import_audit?.file_size_bytes ?? 0) > 0);
    assert.match(result.data?.manual_import_audit?.file_mtime ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualCsvProvider rejects malformed CSV instead of fabricating data", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-bad-csv-"));
  try {
    await writeFile(path.join(dir, "007951.csv"), ["fund_code,date", "007951,2026-05-28"].join("\n"));

    const result = await new ManualCsvProvider(dir).fetch({
      fund_code: "007951",
      required_data: ["fund_meta", "current_nav", "nav_history"],
      demo_mode: false
    });

    assert.equal(result.success, false);
    assert.match(result.error ?? "", /missing required columns/i);
    assert.equal(result.data, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualCsvProvider rejects invalid calendar dates and numeric fields", async () => {
  assert.throws(
    () => ManualCsvProvider.parseCsv(["fund_code,date,nav,daily_return", "007951,2026-02-31,1.018,0.12"].join("\n")),
    /invalid date/
  );
  assert.throws(
    () => ManualCsvProvider.parseCsv(["fund_code,date,nav,daily_return", "007951,2999-01-01,1.018,0.12"].join("\n")),
    /future date/
  );
  assert.throws(
    () => ManualCsvProvider.parseCsv(["fund_code,date,nav,daily_return", "007951,2026-05-28,1.018,not-a-number"].join("\n")),
    /invalid daily_return/
  );
});

test("Argus can use manual CSV as explicit real-data fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-argus-csv-"));
  try {
    await writeFile(
      path.join(dir, "007951.csv"),
      [
        "fund_code,date,nav,fund_name,fund_type,daily_return",
        "007951,2026-05-27,1.015,招商信用增强债券C,债券型,0.30",
        "007951,2026-05-28,1.018,招商信用增强债券C,债券型,0.29"
      ].join("\n")
    );
    const registry = new SourceRegistry({
      enableLiveProviders: false,
      providers: [new ManualCsvProvider(dir)],
      cacheTtlMs: 0,
      retryCount: 0
    });
    const { dataPack, result } = await new ArgusAgent(registry).prepareDataPack("manual-csv-flow", "007951");

    assert.equal(dataPack.is_mock, false);
    assert.equal(result.is_mock, false);
    assert.equal(dataPack.fund_name, "招商信用增强债券C");
    assert.equal(dataPack.current_nav, 1.018);
    assert.equal(dataPack.data_quality_report.missing_core_fields.length, 0);
    assert.equal(dataPack.allow_downstream_analysis, true);
    assert.ok(dataPack.data_sources.some((source) => source.source_id === "manual-csv-import" && source.success === true));
    const manualSource = dataPack.data_sources.find((source) => source.source_id === "manual-csv-import");
    assert.equal((manualSource?.manual_import_audit as { latest_date?: string } | undefined)?.latest_date, "2026-05-28");
    assert.equal((manualSource?.manual_import_audit as { file_sha256?: string } | undefined)?.file_sha256?.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ManualCsvProvider remains available when external live providers are disabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fundsentinel-manual-disabled-live-"));
  try {
    await writeFile(path.join(dir, "007951.csv"), ["fund_code,date,nav,fund_name", "007951,2026-05-28,1.018,招商信用增强债券C"].join("\n"));
    const registry = new SourceRegistry({
      enableLiveProviders: false,
      providers: [new ManualCsvProvider(dir)],
      cacheTtlMs: 0
    });

    const result = (await registry.fetchAll({ fund_code: "007951", required_data: ["fund_meta", "current_nav", "nav_history"], demo_mode: false }))[0];

    assert.equal(result.source_id, "manual-csv-import");
    assert.equal(result.success, true);
    assert.equal(result.data?.current_nav, 1.018);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
