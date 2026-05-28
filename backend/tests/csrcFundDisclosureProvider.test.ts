import assert from "node:assert/strict";
import test from "node:test";
import { CsrcFundDisclosureProvider } from "../src/dataSources/index.js";

test("CSRC fund disclosure parser extracts official periodic report links conservatively", () => {
  const html = `
    <html><body>
      <a href="/fund/disclosure/007951/20260422/report.pdf">招商信用增强债券C 007951 2026年第1季度报告 2026-04-22</a>
      <a href="/fund/disclosure/007951/prompt.html">招商信用增强债券C 007951 2026年第1季度报告提示性公告 2026-04-21</a>
      <a href="/fund/disclosure/000001/other.pdf">其他基金 000001 2026年第1季度报告 2026-04-22</a>
    </body></html>
  `;

  const documents = CsrcFundDisclosureProvider.parseDisclosurePage(html, "007951", "http://eid.csrc.gov.cn/fund/");

  assert.equal(documents.length, 2);
  assert.equal(documents[0].source_type, "official_disclosure");
  assert.equal(documents[0].trust_level, "A");
  assert.equal(documents[0].document_kind, "periodic_report");
  assert.equal(documents[0].published_at, "2026-04-22");
  assert.equal(documents[0].pdf_url, "http://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf");
  assert.equal(documents[1].document_kind, "report_notice");
});

test("CSRC provider reports blocked official site as explicit data gap failure", async () => {
  const provider = new CsrcFundDisclosureProvider(
    async () =>
      new Response("<title>405</title>很抱歉，由于您访问的URL有可能对网站造成安全威胁，您的访问被阻断。", {
        status: 405
      }),
    100,
    ["http://eid.csrc.gov.cn/fund"]
  );

  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.source_id, "csrc-fund-disclosure");
  assert.equal(result.trust_level, "A");
  assert.match(result.error ?? "", /HTTP 405/);
  assert.ok(result.warnings.some((warning) => warning.includes("官方披露缺口")));
});
