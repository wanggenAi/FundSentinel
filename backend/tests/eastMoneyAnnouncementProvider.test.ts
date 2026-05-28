import assert from "node:assert/strict";
import test from "node:test";
import { EastMoneyFundAnnouncementProvider } from "../src/dataSources/index.js";

const announcementJson = {
  Data: [
    {
      FUNDCODE: "007951",
      TITLE: "招商信用增强债券型证券投资基金2026年第1季度报告",
      ShortTitle: "招商信用增强债券C",
      NEWCATEGORY: "3",
      PUBLISHDATE: "2026-04-22T00:00:00",
      PUBLISHDATEDesc: "2026-04-22",
      ATTACHTYPE: "0",
      ID: "AN202604221821422841"
    },
    {
      FUNDCODE: "007951",
      TITLE: "招商信用增强债券型证券投资基金2025年年度报告",
      ShortTitle: "招商信用增强债券C",
      NEWCATEGORY: "3",
      PUBLISHDATE: "2026-03-31T00:00:00",
      PUBLISHDATEDesc: "2026-03-31",
      ATTACHTYPE: "0",
      ID: "AN202603311820902349"
    }
  ],
  ErrCode: 0,
  TotalCount: 2,
  PageSize: 20,
  PageIndex: 1
};

test("EastMoney announcement parser handles JSON and JSONP report indexes", () => {
  const jsonParsed = EastMoneyFundAnnouncementProvider.parseAnnouncementData(JSON.stringify(announcementJson));
  const jsonpParsed = EastMoneyFundAnnouncementProvider.parseAnnouncementData(`callback123(${JSON.stringify(announcementJson)})`);

  assert.equal(jsonParsed.totalCount, 2);
  assert.equal(jsonParsed.items[0]?.TITLE, "招商信用增强债券型证券投资基金2026年第1季度报告");
  assert.deepEqual(jsonpParsed, jsonParsed);
});

test("EastMoney announcement provider returns report references with provenance", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "377592" }
      });
    }
    return new Response(JSON.stringify(announcementJson), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const provider = new EastMoneyFundAnnouncementProvider(fetchImpl, 1000, 2);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "eastmoney-fund-announcement");
  assert.equal(result.data?.fund_name, "招商信用增强债券C");
  assert.equal(result.data?.fund_report_refs?.length, 2);
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("AN202604221821422841"));
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("pdf=https://pdf.dfcfw.com/pdf/H2_AN202604221821422841_1.pdf"));
  assert.equal(result.data?.fund_report_documents?.[0]?.announcement_id, "AN202604221821422841");
  assert.equal(result.data?.fund_report_documents?.[0]?.detail_url, "https://fund.eastmoney.com/gonggao/007951,AN202604221821422841.html");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_url, "https://pdf.dfcfw.com/pdf/H2_AN202604221821422841_1.pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_length, 377592);
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "aggregator_index");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "periodic_report");
  assert.ok(result.data?.news_summaries?.[0]?.includes("定期报告公告"));
  assert.match(result.raw_reference ?? "", /api\.fund\.eastmoney\.com/);
});
