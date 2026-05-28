import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { CsrcFundDisclosureProvider, SourceRegistry } from "../src/dataSources/index.js";

const csrcDisclosureHtml = `
  <html><body>
    <a href="/fund/disclosure/007951/20260422/report.pdf">招商信用增强债券C 007951 2026年第1季度报告 2026-04-22</a>
    <a href="/fund/disclosure/007951/prompt.html">招商信用增强债券C 007951 2026年第1季度报告提示性公告 2026-04-21</a>
    <a href="/fund/disclosure/000001/other.pdf">其他基金 000001 2026年第1季度报告 2026-04-22</a>
  </body></html>
`;

test("CSRC fund disclosure parser extracts official periodic report links conservatively", () => {
  const documents = CsrcFundDisclosureProvider.parseDisclosurePage(csrcDisclosureHtml, "007951", "http://eid.csrc.gov.cn/fund/");

  assert.equal(documents.length, 2);
  assert.equal(documents[0].source_type, "official_disclosure");
  assert.equal(documents[0].trust_level, "A");
  assert.equal(documents[0].document_kind, "periodic_report");
  assert.equal(documents[0].published_at, "2026-04-22");
  assert.equal(documents[0].pdf_url, "http://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf");
  assert.equal(documents[0].pdf_verified, false);
  assert.equal(documents[1].document_kind, "report_notice");
});

test("CSRC provider verifies official periodic report PDF metadata", async () => {
  const seen: Array<{ url: string; method?: string }> = [];
  const provider = new CsrcFundDisclosureProvider(
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, method: init?.method });
      if (url === "http://eid.csrc.gov.cn/fund/007951") {
        return new Response(csrcDisclosureHtml, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === "http://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf" && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "234567" }
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    1000,
    ["http://eid.csrc.gov.cn/fund/{fund_code}"],
    1
  );

  const result = await provider.fetch({
    fund_code: "007951",
    required_data: ["fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "csrc-fund-disclosure");
  assert.equal(result.source_type, "regulatory_disclosure");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_report_documents?.length, 2);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_length, 234567);
  assert.ok(result.data?.fund_report_refs?.[0]?.includes("pdf_verified=true"));
  assert.ok(seen.some((call) => call.url.endsWith("/report.pdf") && call.method === "HEAD"));
  assert.equal(result.warnings.some((warning) => warning.includes("尚未通过 PDF 元数据校验")), false);
});

test("Argus counts CSRC official reports only after official PDF metadata is verified", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://eid.csrc.gov.cn/fund/007951") {
      return new Response(csrcDisclosureHtml, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (url === "http://eid.csrc.gov.cn/fund/disclosure/007951/20260422/report.pdf" && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "234567" }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new CsrcFundDisclosureProvider(fetchImpl, 1000, ["http://eid.csrc.gov.cn/fund/{fund_code}"], 1)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("csrc-official-report-flow", "007951");

  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("fund_reports"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
  assert.equal(dataPack.data_quality_report.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
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
