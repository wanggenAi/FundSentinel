import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { CmfChinaFundOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const fundDetailHtml = `
<div class="pro_name"><div class="title"><h5>招商信用增强债券C</h5><a class="type_switch"></a></div>
<div class="info"><span class="fund_code">007951</span><span class="fund_tag">中低风险(R2)</span><span class="fund_tag">债券型</span></div></div>
<div class="num"><strong>1.0799</strong></div><p>单位净值(2026-05-28)</p>
<div class="color_green num"><strong>-0.02%</strong></div><p>日涨幅</p>
<script>
fw.pageNum=1;fw.pageSize=10;fw.total=3;fw.pages=1;fw.list=[
  {valueId:2337093,productId:342717,relatePrice:E,cumulativeNet:F,navDate:j,dayRate:U,productCode:d},
  {valueId:2336333,productId:342717,relatePrice:"1.0801",cumulativeNet:"1.3283",navDate:"2026-05-27",dayRate:"-0.194",productCode:d},
  {valueId:2335416,productId:342717,relatePrice:"1.0822",cumulativeNet:"1.3304",navDate:"2026-05-26",dayRate:"0.064",productCode:d}
];return {data:{"fundNavPage-007951-[object Object]":fw}};
</script>
<a class="item" href="/web/noticedetails/223506/index.html" target="_blank"><p>招商基金管理有限公司旗下基金2026年第1季度报告提示性公告</p><span class="date">2026-04-22</span></a>
<a class="item" href="/web/noticedetails/224074/index.html" target="_blank"><p>关于暂停招商信用增强债券型证券投资基金大额申购业务的公告</p><span class="date">2026-05-19</span></a>
`;

const fundDetailWithFullReportHtml = `
${fundDetailHtml}
<a class="item" href="/web/noticedetails/223999/index.html" target="_blank"><p>招商信用增强债券型证券投资基金2026年第1季度报告</p><span class="date">2026-04-22</span></a>
`;

const reportNoticeDetailHtml = `
<div class="article_detail_title"><div class="wrapfix"><h2>招商基金管理有限公司旗下基金2026年第1季度报告提示性公告</h2><div style="" class="data">2026-04-22</div></div></div>
<p>2026年第1季度报告全文于2026年4月22日在本公司网站（http://www.cmfchina.com）和中国证监会基金电子披露网站（http://eid.csrc.gov.cn/fund）披露。</p>
`;

const fullReportDetailHtml = `
<div class="article_detail_title"><div class="wrapfix"><h2>招商信用增强债券型证券投资基金2026年第1季度报告</h2><div style="" class="data">2026-04-22</div></div></div>
<p>本报告全文详见附件。</p>
<a href="/upload/report/007951-2026q1.pdf">招商信用增强债券型证券投资基金2026年第1季度报告PDF</a>
`;

test("CMF China parser extracts official fund detail notices conservatively", () => {
  const parsed = CmfChinaFundOfficialProvider.parseFundDetailPage(fundDetailHtml, "007951");

  assert.equal(parsed.fundName, "招商信用增强债券C");
  assert.equal(parsed.fundType, "债券型");
  assert.equal(parsed.currentNav, 1.0799);
  assert.equal(parsed.currentNavDate, "2026-05-28");
  assert.equal(parsed.dailyReturn, -0.02);
  assert.deepEqual(parsed.navHistory, [1.0822, 1.0801, 1.0799]);
  assert.deepEqual(parsed.navHistoryDates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(parsed.notices.length, 2);
  assert.equal(parsed.notices[0]?.adId, "223506");
});

test("CMF China parser discovers official report PDFs from notice details", () => {
  const parsed = CmfChinaFundOfficialProvider.parseNoticeDetailPage(
    fullReportDetailHtml,
    "https://www.cmfchina.com/web/noticedetails/223999/index.html"
  );

  assert.equal(parsed.title, "招商信用增强债券型证券投资基金2026年第1季度报告");
  assert.equal(parsed.publishedAt, "2026-04-22");
  assert.equal(parsed.pdfUrl, "https://www.cmfchina.com/upload/report/007951-2026q1.pdf");
});

test("CMF China provider records official report notice without pretending it is report body", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/web/noticedetails/223506/index.html")) {
      return new Response(reportNoticeDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response(fundDetailHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const provider = new CmfChinaFundOfficialProvider(fetchImpl, 1000, 2);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports", "fund_meta", "current_nav"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "cmfchina-fund-official");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "招商信用增强债券C");
  assert.deepEqual(result.data?.nav_history, [1.0822, 1.0801, 1.0799]);
  assert.deepEqual(result.data?.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(result.data?.fund_report_documents?.length, 2);
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "official_disclosure");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "report_notice");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, false);
  assert.equal(result.data?.fund_report_documents?.[0]?.trust_level, "A");
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "business_notice");
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("kind=report_notice"));
  assert.ok(result.warnings.some((warning) => warning.includes("报告全文仍需继续接入")));
});

test("CMF China provider verifies official periodic report PDF metadata", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/web/noticedetails/223506/index.html")) {
      return new Response(reportNoticeDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.includes("/web/noticedetails/223999/index.html")) {
      return new Response(fullReportDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url === "https://www.cmfchina.com/upload/report/007951-2026q1.pdf" && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "345678" }
      });
    }
    return new Response(fundDetailWithFullReportHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;

  const provider = new CmfChinaFundOfficialProvider(fetchImpl, 1000, 3, 1);
  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports", "fund_meta", "current_nav"],
    demo_mode: false
  });

  const fullReport = result.data?.fund_report_documents?.find((document) => document.announcement_id === "223999");
  assert.equal(result.success, true);
  assert.equal(fullReport?.document_kind, "periodic_report");
  assert.equal(fullReport?.pdf_url, "https://www.cmfchina.com/upload/report/007951-2026q1.pdf");
  assert.equal(fullReport?.pdf_verified, true);
  assert.equal(fullReport?.pdf_content_type, "application/pdf");
  assert.equal(fullReport?.pdf_content_length, 345678);
  assert.ok(result.data?.fund_report_refs?.some((ref) => ref.includes("pdf_verified=true")));
});

test("Argus counts CMF China official reports only after official PDF metadata is verified", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/web/noticedetails/223506/index.html")) {
      return new Response(reportNoticeDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url.includes("/web/noticedetails/223999/index.html")) {
      return new Response(fullReportDetailHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url === "https://www.cmfchina.com/upload/report/007951-2026q1.pdf" && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "345678" }
      });
    }
    return new Response(fundDetailWithFullReportHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new CmfChinaFundOfficialProvider(fetchImpl, 1000, 3, 1)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("cmf-official-report-flow", "007951");

  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.current_nav, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
});
