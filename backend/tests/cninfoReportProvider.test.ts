import assert from "node:assert/strict";
import test from "node:test";
import { CninfoReportProvider } from "../src/dataSources/index.js";

const fundStockJson = JSON.stringify({
  stockList: [
    {
      code: "161713",
      pinyin: "zsxytllof",
      category: "LOF",
      orgId: "jjjl0000060",
      zwjc: "招商信用添利LOF"
    }
  ]
});

const announcementJson = JSON.stringify({
  totalAnnouncement: 2,
  totalRecordNum: 2,
  announcements: [
    {
      secCode: "161713",
      secName: "招商信用添利LOF",
      orgId: "jjjl0000060",
      announcementId: "1225139315",
      announcementTitle: "招商信用添利债券型证券投资基金(LOF)2026年第1<em>季度</em><em>报告</em>",
      announcementTime: 1776787200000,
      adjunctUrl: "finalpage/2026-04-22/1225139315.PDF",
      adjunctSize: 338,
      adjunctType: "PDF",
      pageColumn: "SZJJ",
      shortTitle: "招商信用添利债券型证券投资基金(LOF)2026年第1季度报告"
    },
    {
      secCode: "000001",
      secName: "其他基金",
      orgId: "jjjl0000001",
      announcementId: "ignore",
      announcementTitle: "其他基金2026年第1季度报告",
      announcementTime: 1776787200000,
      adjunctUrl: "finalpage/2026-04-22/ignore.PDF",
      adjunctType: "PDF"
    }
  ]
});

test("CNInfo provider parses official listed-fund report PDF metadata", async () => {
  const seen: Array<{ url: string; body?: string; method?: string }> = [];
  const provider = new CninfoReportProvider(
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, body: String(init?.body ?? ""), method: init?.method });
      if (url.endsWith("/new/data/fund_stock.json")) {
        return new Response(fundStockJson, {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/new/hisAnnouncement/query")) {
        return new Response(announcementJson, {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "https://static.cninfo.com.cn/finalpage/2026-04-22/1225139315.PDF" && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "345258" }
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    1000,
    1,
    ["季度报告"]
  );

  const result = await provider.fetch({
    fund_code: "161713",
    required_data: ["fund_reports", "fund_meta"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "cninfo-report");
  assert.equal(result.source_type, "regulatory_disclosure");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "招商信用添利LOF");
  assert.equal(result.data?.fund_type, "LOF");
  assert.equal(result.data?.fund_report_documents?.length, 1);
  assert.equal(result.data?.fund_report_documents?.[0]?.announcement_id, "1225139315");
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "official_disclosure");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_url, "https://static.cninfo.com.cn/finalpage/2026-04-22/1225139315.PDF");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_length, 345258);
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("1225139315"));
  assert.ok(result.data?.news_summaries?.[0]?.includes("巨潮资讯官方基金公告"));
  assert.ok(seen.some((call) => call.url.endsWith("/new/hisAnnouncement/query") && call.body?.includes("stock=161713%2Cjjjl0000060")));
});

test("CNInfo provider fails explicitly when fund code is outside precise fund list coverage", async () => {
  const provider = new CninfoReportProvider(
    (async () =>
      new Response(fundStockJson, {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as typeof fetch,
    1000,
    0
  );

  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found in CNInfo fund security list/);
  assert.ok(result.warnings.some((warning) => warning.includes("不会用关键词全站搜索替代精确代码匹配")));
});
