import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { FundCompanyReportProvider, SecEdgarProvider, SourceRegistry } from "../src/dataSources/index.js";

const secTickerExchangeJson = JSON.stringify({
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [884394, "SPDR S&P 500 ETF TRUST", "SPY", "NYSE"],
    [320193, "APPLE INC", "AAPL", "Nasdaq"]
  ]
});

const secSubmissionsJson = JSON.stringify({
  cik: "0000884394",
  name: "SPDR S&P 500 ETF TRUST",
  tickers: ["SPY"],
  exchanges: ["NYSE"],
  filings: {
    recent: {
      accessionNumber: ["0001410368-26-055357", "0001410368-26-023904", "0001193125-26-023648", "0000000000-26-000001"],
      filingDate: ["2026-05-28", "2026-03-13", "2026-01-27", "2026-01-01"],
      reportDate: ["2026-04-30", "2025-12-31", "2026-01-27", "2026-01-01"],
      form: ["NPORT-P", "N-CEN", "485BPOS", "8-K"],
      primaryDocument: ["primary_doc.xml", "ncen.xml", "prospectus.htm", "event.htm"],
      primaryDocDescription: ["Monthly Portfolio Investments Report", "Annual Report for Registered Investment Companies", "Post-effective amendment", "Current report"]
    }
  }
});

test("SecEdgarProvider parses official SEC ticker exchange index", () => {
  const rows = SecEdgarProvider.parseTickerExchange(secTickerExchangeJson);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    cik: 884394,
    name: "SPDR S&P 500 ETF TRUST",
    ticker: "SPY",
    exchange: "NYSE"
  });
});

test("SecEdgarProvider filters SEC submissions to fund disclosure filings", () => {
  const filings = SecEdgarProvider.relevantFundFilings(SecEdgarProvider.parseSubmissions(secSubmissionsJson));

  assert.equal(filings.length, 3);
  assert.deepEqual(
    filings.map((filing) => filing.form),
    ["NPORT-P", "N-CEN", "485BPOS"]
  );
  assert.equal(filings[0]?.accessionNumber, "0001410368-26-055357");
});

test("SecEdgarProvider returns official EDGAR filing metadata without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("company_tickers_exchange.json")) return new Response(secTickerExchangeJson, { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("CIK0000884394.json")) return new Response(secSubmissionsJson, { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await new SecEdgarProvider(fetchImpl, 1000).fetch({
    fund_code: "SPY",
    required_data: ["fund_reports", "industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "sec-edgar");
  assert.equal(result.source_type, "regulatory_disclosure");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_code, "SPY");
  assert.equal(result.data?.fund_name, "SPDR S&P 500 ETF TRUST");
  assert.equal(result.data?.fund_report_documents?.length, 3);
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "periodic_report");
  assert.match(result.data?.fund_report_documents?.[0]?.detail_url ?? "", /Archives\/edgar\/data\/884394\/000141036826055357/);
  assert.match(result.raw_reference ?? "", /data\.sec\.gov\/submissions\/CIK0000884394\.json/);
  assert.ok(result.warnings.some((warning) => warning.includes("不解析正文")));
  assert.doesNotMatch(JSON.stringify(result), /trial_buy|staged_buy|\b(buy|sell|position)\b/i);
});

test("SecEdgarProvider does not handle Chinese six-digit fund codes", async () => {
  const provider = new SecEdgarProvider(async () => new Response("unexpected", { status: 500 }), 1000);

  assert.equal(
    provider.canHandle({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false
    }),
    false
  );
});

test("SecEdgarProvider fails explicitly when ticker is absent from SEC index", async () => {
  const fetchImpl = (async () => new Response(secTickerExchangeJson, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const result = await new SecEdgarProvider(fetchImpl, 1000).fetch({
    fund_code: "NOETF",
    required_data: ["fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /No SEC ticker\/CIK match/);
});

test("Argus preserves SEC filing metadata without allowing core fund analysis", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("company_tickers_exchange.json")) return new Response(secTickerExchangeJson, { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("CIK0000884394.json")) return new Response(secSubmissionsJson, { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new SecEdgarProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("sec-edgar-flow", "SPY");

  assert.equal(dataPack.fund_name, "SPDR S&P 500 ETF TRUST");
  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("current_nav"));
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("SEC EDGAR 官方披露")));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "sec-edgar" && source.record_count === 3));
});

test("Argus runs report coordinator after SEC metadata without upgrading unverified EDGAR filings", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("company_tickers_exchange.json")) return new Response(secTickerExchangeJson, { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("CIK0000884394.json")) return new Response(secSubmissionsJson, { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new SecEdgarProvider(fetchImpl, 1000), new FundCompanyReportProvider()],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("sec-edgar-coordination-flow", "SPY");
  const reportCoordinator = dataPack.data_sources.find((source) => source.source_id === "fund-company-report");
  const secIndex = dataPack.data_sources.findIndex((source) => source.source_id === "sec-edgar");
  const coordinatorIndex = dataPack.data_sources.findIndex((source) => source.source_id === "fund-company-report");
  const coordinatorFailure = dataPack.data_gap_report?.failed_source_details.find((source) => source.source_id === "fund-company-report");

  assert.ok(secIndex >= 0);
  assert.ok(coordinatorIndex > secIndex);
  assert.equal(reportCoordinator?.success, false);
  assert.match(reportCoordinator?.raw_reference ?? "", /sec\.gov\/Archives/);
  assert.match(coordinatorFailure?.raw_reference ?? "", /sec\.gov\/Archives/);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), true);
  assert.ok(dataPack.data_quality_report.warnings.some((warning) => warning.includes("已发现官方定期报告 PDF 但未通过元数据校验")));
});
