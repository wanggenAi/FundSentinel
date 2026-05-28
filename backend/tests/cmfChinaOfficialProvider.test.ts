import assert from "node:assert/strict";
import test from "node:test";
import { CmfChinaFundOfficialProvider } from "../src/dataSources/index.js";

const fundDetailHtml = `
<div class="pro_name"><div class="title"><h5>招商信用增强债券C</h5><a class="type_switch"></a></div>
<div class="info"><span class="fund_code">007951</span><span class="fund_tag">中低风险(R2)</span><span class="fund_tag">债券型</span></div></div>
<div class="num"><strong>1.0799</strong></div><p>单位净值(2026-05-28)</p>
<div class="color_green num"><strong>-0.02%</strong></div><p>日涨幅</p>
<a class="item" href="/web/noticedetails/223506/index.html" target="_blank"><p>招商基金管理有限公司旗下基金2026年第1季度报告提示性公告</p><span class="date">2026-04-22</span></a>
<a class="item" href="/web/noticedetails/224074/index.html" target="_blank"><p>关于暂停招商信用增强债券型证券投资基金大额申购业务的公告</p><span class="date">2026-05-19</span></a>
`;

const reportNoticeDetailHtml = `
<div class="article_detail_title"><div class="wrapfix"><h2>招商基金管理有限公司旗下基金2026年第1季度报告提示性公告</h2><div style="" class="data">2026-04-22</div></div></div>
<p>2026年第1季度报告全文于2026年4月22日在本公司网站（http://www.cmfchina.com）和中国证监会基金电子披露网站（http://eid.csrc.gov.cn/fund）披露。</p>
`;

test("CMF China parser extracts official fund detail notices conservatively", () => {
  const parsed = CmfChinaFundOfficialProvider.parseFundDetailPage(fundDetailHtml, "007951");

  assert.equal(parsed.fundName, "招商信用增强债券C");
  assert.equal(parsed.fundType, "债券型");
  assert.equal(parsed.currentNav, 1.0799);
  assert.equal(parsed.dailyReturn, -0.02);
  assert.equal(parsed.notices.length, 2);
  assert.equal(parsed.notices[0]?.adId, "223506");
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
  assert.equal(result.data?.fund_report_documents?.length, 2);
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "official_disclosure");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "report_notice");
  assert.equal(result.data?.fund_report_documents?.[0]?.trust_level, "A");
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "business_notice");
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("kind=report_notice"));
  assert.ok(result.warnings.some((warning) => warning.includes("报告全文仍需继续接入")));
});
