import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import {
  HkexOfficialProvider,
  SourceRegistry,
  type DataProvider,
  type DataProviderResult,
  type DataSourceInfo,
  type FundDataSourceInput,
  type ProviderFundPayload
} from "../src/dataSources/index.js";

const stockPrefixJsonp = `callback({"more":"1","stockInfo":[{"stockId":7609,"code":"00700","name":"TENCENT"}]});`;

const hkexTitleSearchHtml = `
<table>
  <tbody>
    <tr>
      <td class="release-time"><span>Release Time: </span>28/05/2026 18:09</td>
      <td class="stock-short-code"><span>Stock Code: </span>00700</td>
      <td class="stock-short-name"><span>Stock Short Name: </span>TENCENT</td>
      <td class="document-details">
        <div class="headline">Announcements and Notices - [Overseas Regulatory Announcement - Corporate Governance Related Matters]<br /></div>
        <div class="doc-link">
          <a href="/listedco/listconews/sehk/2026/0528/2026052801225.htm">An announcement has just been published by the issuer in the Chinese section</a>
        </div>
      </td>
    </tr>
    <tr>
      <td class="release-time"><span>Release Time: </span>21/04/2026 06:01</td>
      <td class="stock-short-code"><span>Stock Code: </span>00700</td>
      <td class="stock-short-name"><span>Stock Short Name: </span>TENCENT</td>
      <td class="document-details">
        <div class="headline">Financial Statements/ESG Information - [Annual Report]</div>
        <div class="doc-link">
          <a href="/listedco/listconews/sehk/2026/0421/2026042100562.pdf">Annual Report 2025</a>
        </div>
      </td>
    </tr>
  </tbody>
</table>
`;

test("HkexOfficialProvider parses HKEX stock prefix JSONP and title-search rows", () => {
  const stocks = HkexOfficialProvider.parseStockSearchResponse(stockPrefixJsonp);
  const announcements = HkexOfficialProvider.parseTitleSearchPage(hkexTitleSearchHtml, "https://www1.hkexnews.hk/search/titlesearch.xhtml?stockId=7609");

  assert.equal(stocks.length, 1);
  assert.equal(stocks[0]?.stockId, 7609);
  assert.equal(stocks[0]?.code, "00700");
  assert.equal(announcements.length, 2);
  assert.equal(announcements[0]?.release_time, "2026-05-28 18:09");
  assert.equal(announcements[0]?.release_date, "2026-05-28");
  assert.equal(announcements[0]?.stock_code, "00700");
  assert.equal(announcements[0]?.stock_name, "TENCENT");
  assert.equal(announcements[0]?.document_type, "html");
  assert.equal(announcements[1]?.document_type, "pdf");
  assert.equal(announcements[1]?.document_url, "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0421/2026042100562.pdf");
});

test("HkexOfficialProvider only handles Hong Kong market context, not fund-report requests", () => {
  const provider = new HkexOfficialProvider(async () => new Response("unexpected", { status: 500 }), 1000, []);

  assert.equal(
    provider.canHandle({
      fund_code: "007951",
      required_data: ["fund_reports"],
      demo_mode: false,
      context: { themes: ["港股"] }
    }),
    false
  );
  assert.equal(
    provider.canHandle({
      fund_code: "007951",
      required_data: ["industry_news"],
      demo_mode: false,
      context: { fund_name: "港股通主题基金", themes: ["港股"], portfolio_holdings: ["腾讯控股 00700.HK"] }
    }),
    true
  );
  assert.deepEqual(HkexOfficialProvider.extractStockQueries({ portfolio_holdings: ["腾讯控股 00700.HK", "HK:9988"] }), ["00700", "09988"]);
});

test("HkexOfficialProvider returns official announcement context without fund advice", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("prefix.do")) return new Response(stockPrefixJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    if (url.includes("titlesearch.xhtml")) return new Response(hkexTitleSearchHtml, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await new HkexOfficialProvider(fetchImpl, 1000, [], 2, 5).fetch({
    fund_code: "007951",
    required_data: ["industry_news", "policy_evidence"],
    demo_mode: false,
    context: { fund_name: "港股通主题基金", themes: ["港股"], portfolio_holdings: ["腾讯控股 00700.HK"] }
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "hkex-official");
  assert.equal(result.source_type, "news");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_report_documents, undefined);
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("TENCENT")));
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("HKEXnews 官方公告")));
  assert.match(result.raw_reference ?? "", /hkexnews\.hk\/search\/titlesearch\.xhtml/);
  assert.ok(result.warnings.some((warning) => warning.includes("不会补齐 official_fund_reports")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|\b(buy|sell|position)\b/i);
});

test("HkexOfficialProvider fails explicitly when HKEX cannot resolve stock candidates", async () => {
  const fetchImpl = (async () => new Response(`callback({"more":"1","stockInfo":[]});`, { status: 200 })) as typeof fetch;

  const result = await new HkexOfficialProvider(fetchImpl, 1000, [], 2, 5).fetch({
    fund_code: "007951",
    required_data: ["industry_news"],
    demo_mode: false,
    context: { fund_name: "港股通主题基金", themes: ["港股"], portfolio_holdings: ["未知 09999.HK"] }
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /No HKEX stock candidates/);
  assert.ok(result.warnings.some((warning) => warning.includes("必须保留 industry_news")));
});

test("Argus preserves HKEX context after earlier providers supply Hong Kong holdings", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("prefix.do")) return new Response(stockPrefixJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    if (url.includes("titlesearch.xhtml")) return new Response(hkexTitleSearchHtml, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new HongKongContextProvider(), new HkexOfficialProvider(fetchImpl, 1000, [], 2, 5)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("hkex-context-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("HKEXnews 官方公告")));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "hkex-official" && source.record_count === 2));
  assert.ok(dataPack.data_quality_report.missing_core_fields.includes("current_nav"));
});

class HongKongContextProvider implements DataProvider<FundDataSourceInput, ProviderFundPayload> {
  sourceInfo(): DataSourceInfo {
    return {
      source_id: "test-hk-context",
      source_name: "test-hk-context",
      source_type: "holdings",
      trust_level: "A",
      enabled: true,
      priority: 40,
      access_method: "test fixture provider",
      requires_auth: false,
      is_demo: false,
      last_success_at: null,
      last_failed_at: null,
      failure_count: 0,
      consecutive_failure_count: 0,
      last_latency_ms: null,
      last_attempt_count: 0,
      cache_hit_count: 0,
      last_cache_hit_at: null,
      circuit_open_until: null,
      circuit_open_count: 0,
      freshness_policy: "test",
      notes: "test provider"
    };
  }

  canHandle(input: FundDataSourceInput): boolean {
    return input.required_data.includes("holdings");
  }

  async fetch(input: FundDataSourceInput): Promise<DataProviderResult<ProviderFundPayload>> {
    return {
      source_id: "test-hk-context",
      source_name: "test-hk-context",
      source_type: "holdings",
      trust_level: "A",
      data_status: "partial",
      success: true,
      data: {
        fund_code: input.fund_code,
        fund_name: "港股通主题基金",
        themes: ["港股"],
        portfolio_holdings: ["腾讯控股 00700.HK"]
      },
      raw_reference: "test://hk-context",
      fetched_at: "2026-05-29T00:00:00.000Z",
      freshness: "fresh",
      warnings: [],
      error: null,
      is_demo: false
    };
  }
}
