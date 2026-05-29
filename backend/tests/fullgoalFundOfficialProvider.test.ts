import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { FullgoalFundOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const fullgoalDetailHtml = `
<html>
  <head><title>富国天惠精选成长混合型证券投资基金（LOF）_富国基金</title></head>
  <body>
    <div class="pro_name">
      <div class="title"><h2>富国天惠成长混合（LOF）A</h2></div>
      <span class="fund_code">161005</span>
      <span class="fund_tag_01">混合型</span>
      <span class="fund_tag_01">中高风险(R4)</span>
    </div>
    <section class="overview">
      <p>单位净值(2026-05-28)</p>
      <strong>3.2157</strong>
      <p>累计净值</p>
      <strong>6.2637</strong>
      <p>日涨跌</p>
      <strong>0.44%</strong>
    </section>
    <table>
      <tr><th>基金名称</th><td>富国天惠精选成长混合型证券投资基金（LOF）</td><th>基金代码</th><td>161005</td></tr>
      <tr><th>基金简称</th><td>富国天惠成长混合（LOF）A</td><th>基金类型</th><td>混合型</td></tr>
      <tr><th>基金管理人</th><td>富国基金管理有限公司</td><th>基金托管人</th><td>中国工商银行股份有限公司</td></tr>
    </table>
    <h3>历史净值</h3>
    <table class="pd_table">
      <tr><th>日期</th><th>单位净值</th><th>累计净值</th><th>日涨跌</th></tr>
      <tr><td>2026-05-28</td><td>3.2157</td><td>6.2637</td><td>0.44%</td></tr>
      <tr><td>2026-05-27</td><td>3.2017</td><td>6.2497</td><td>-0.09%</td></tr>
      <tr><td>2026-05-26</td><td>3.2046</td><td>6.2526</td><td>0.31%</td></tr>
    </table>
    <ul class="notice-list">
      <li>
        <a href="/noticedetails/105014/index.html">
          <p>富国天惠精选成长混合型证券投资基金（LOF）二0二六年第1季度报告</p>
          <span class="time">2026-04-22</span>
        </a>
      </li>
      <li>
        <a href="/noticedetails/104349/index.html">
          <p>富国天惠精选成长混合型证券投资基金（LOF）二0二五年年度报告</p>
          <span class="time">2026-03-31</span>
        </a>
      </li>
      <li>
        <a href="/noticedetails/103753/index.html">
          <p>富国天惠精选成长混合型证券投资基金（LOF）2025年第一次收益分配公告</p>
          <span class="time">2026-03-19</span>
        </a>
      </li>
    </ul>
    <a href="/login">登录</a>
  </body>
</html>
`;

const fullgoalQuarterlyDetailHtml = `
<html>
  <body>
    <article>
      <h2>富国天惠精选成长混合型证券投资基金（LOF）二0二六年第1季度报告</h2>
      <span class="notice_date">2026年04月22日</span>
      <a href="/wbs-file/fund_report/20260422/CN_50100000_161005_FB030010_20260004.pdf">下载PDF</a>
      <iframe src="/pdfjs/web/viewer.html?file=/wbs-file/fund_report/20260422/CN_50100000_161005_FB030010_20260004.pdf"></iframe>
    </article>
  </body>
</html>
`;

const fullgoalAnnualDetailHtml = `
<html>
  <body>
    <article>
      <h2>富国天惠精选成长混合型证券投资基金（LOF）二0二五年年度报告</h2>
      <span class="notice_date">2026年03月31日</span>
      <a href="/wbs-file/fund_report/20260331/CN_50100000_161005_FB010010_20260002.pdf">下载PDF</a>
    </article>
  </body>
</html>
`;

const fullgoalBusinessNoticeHtml = `
<html>
  <body>
    <h2>富国天惠精选成长混合型证券投资基金（LOF）2025年第一次收益分配公告</h2>
    <span class="notice_date">2026年03月19日</span>
  </body>
</html>
`;

test("Fullgoal official parser extracts SSR detail, NAV rows, notices, and PDF URL", () => {
  const detail = FullgoalFundOfficialProvider.parseFundDetailPage(fullgoalDetailHtml, "161005");
  const noticeDetail = FullgoalFundOfficialProvider.parseNoticeDetailPage(
    fullgoalQuarterlyDetailHtml,
    "https://www.fullgoal.com.cn/noticedetails/105014/index.html"
  );

  assert.equal(detail.fundName, "富国天惠成长混合（LOF）A");
  assert.equal(detail.fundFullName, "富国天惠精选成长混合型证券投资基金（LOF）");
  assert.equal(detail.fundType, "混合型");
  assert.equal(detail.currentNav, 3.2157);
  assert.equal(detail.accumulatedNav, 6.2637);
  assert.equal(detail.currentNavDate, "2026-05-28");
  assert.equal(detail.dailyReturn, 0.44);
  assert.deepEqual(
    detail.navRows.map((row) => row.date),
    ["2026-05-26", "2026-05-27", "2026-05-28"]
  );
  assert.deepEqual(
    detail.navRows.map((row) => row.nav),
    [3.2046, 3.2017, 3.2157]
  );
  assert.equal(detail.notices.length, 3);
  assert.equal(detail.notices[0]?.detailUrl, "https://www.fullgoal.com.cn/noticedetails/105014/index.html");
  assert.equal(noticeDetail.title, "富国天惠精选成长混合型证券投资基金（LOF）二0二六年第1季度报告");
  assert.equal(noticeDetail.publishedAt, "2026-04-22");
  assert.equal(noticeDetail.pdfUrl, "https://www.fullgoal.com.cn/wbs-file/fund_report/20260422/CN_50100000_161005_FB030010_20260004.pdf");
});

test("Fullgoal official provider returns official NAV and verified report metadata without advice", async () => {
  const result = await new FullgoalFundOfficialProvider(fullgoalFetchImpl, 1000).fetch({
    fund_code: "161005",
    required_data: ["fund_meta", "current_nav", "nav_history", "fund_reports"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "fullgoal-fund-official");
  assert.equal(result.source_type, "fund_company");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.equal(result.data?.fund_name, "富国天惠成长混合（LOF）A");
  assert.equal(result.data?.fund_type, "混合型");
  assert.equal(result.data?.current_nav, 3.2157);
  assert.equal(result.data?.daily_return, 0.44);
  assert.deepEqual(result.data?.nav_history, [3.2046, 3.2017, 3.2157]);
  assert.deepEqual(result.data?.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(result.data?.fund_report_documents?.[0]?.source_type, "official_disclosure");
  assert.equal(result.data?.fund_report_documents?.[0]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_url, "https://www.fullgoal.com.cn/wbs-file/fund_report/20260422/CN_50100000_161005_FB030010_20260004.pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_verified, true);
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_type, "application/pdf");
  assert.equal(result.data?.fund_report_documents?.[0]?.pdf_content_length, 474821);
  assert.equal(result.data?.fund_report_documents?.[1]?.document_kind, "periodic_report");
  assert.equal(result.data?.fund_report_documents?.[2]?.document_kind, "business_notice");
  assert.ok(result.data?.fund_report_refs?.some((ref) => ref.includes("pdf_verified=true")));
  assert.ok(result.warnings.some((warning) => warning.includes("基金公司官方来源")));
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|buy|sell|position/i);
});

test("Fullgoal official provider fails explicitly when official page is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("<html><title>404 Not Found</title><p>页面不存在</p></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })) as typeof fetch;

  const result = await new FullgoalFundOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "999999",
    required_data: ["fund_meta", "current_nav", "nav_history"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /Fund not found/);
  assert.ok(result.warnings.some((warning) => warning.includes("未返回可验证")));
});

test("Argus recognizes Fullgoal official provider as official core and verified report coverage", async () => {
  const registry = new SourceRegistry({
    providers: [new FullgoalFundOfficialProvider(fullgoalFetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("fullgoal-official-flow", "161005");

  assert.equal(dataPack.fund_name, "富国天惠成长混合（LOF）A");
  assert.equal(dataPack.current_nav, 3.2157);
  assert.deepEqual(dataPack.nav_history_dates, ["2026-05-26", "2026-05-27", "2026-05-28"]);
  assert.equal(dataPack.data_status, "partial");
  assert.equal(dataPack.allow_downstream_analysis, true);
  assert.equal(dataPack.allow_strong_conclusion, false);
  assert.ok(dataPack.data_quality_report.source_composition.authoritative.includes("fullgoal-fund-official"));
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_meta, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.current_nav, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.nav_history, true);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.holdings, false);
  assert.equal(dataPack.data_quality_report.source_composition.official_core_coverage.fund_reports, true);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_current_nav"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_nav_history"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("official_fund_reports"), false);
  assert.equal(dataPack.data_quality_report.missing_auxiliary_fields.includes("policy_evidence"), true);
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "fullgoal-fund-official" && source.record_count === 3));
});

function fullgoalFetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url.includes("/fundDetail/161005/index.html")) return Promise.resolve(htmlResponse(fullgoalDetailHtml));
  if (url.endsWith("/noticedetails/105014/index.html")) return Promise.resolve(htmlResponse(fullgoalQuarterlyDetailHtml));
  if (url.endsWith("/noticedetails/104349/index.html")) return Promise.resolve(htmlResponse(fullgoalAnnualDetailHtml));
  if (url.endsWith("/noticedetails/103753/index.html")) return Promise.resolve(htmlResponse(fullgoalBusinessNoticeHtml));
  if (url.endsWith("CN_50100000_161005_FB030010_20260004.pdf") && init?.method === "HEAD") {
    return Promise.resolve(pdfHeadResponse("474821"));
  }
  if (url.endsWith("CN_50100000_161005_FB010010_20260002.pdf") && init?.method === "HEAD") {
    return Promise.resolve(pdfHeadResponse("812345"));
  }
  return Promise.resolve(htmlResponse("<html></html>"));
}

function htmlResponse(html: string): Response {
  return new Response(Buffer.from(html, "utf8"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function pdfHeadResponse(contentLength: string): Response {
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/pdf", "content-length": contentLength }
  });
}
