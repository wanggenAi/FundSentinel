import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { MiitOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const miitHomepageHtml = `
<html>
  <body>
    <div class="tabbox-hd"><a href="/zwgk/zcwj/index.html">政策文件</a></div>
    <ul>
      <li>
        <p>
          <a href="/zwgk/zcwj/wjfb/gg/art/2026/art_1abc.html" target="_blank" title="工业和信息化部公告 《电器电子产品有害物质限制使用达标管理目录（2026年版）》">工业和信息化部公告 《电器电子产品有害物质限制使用达标管理目录（2026年版）》</a><span>2026-05-28<font class="jd">解读</font></span>
        </p>
      </li>
      <li>
        <p>
          <a href="/zwgk/zcwj/wjfb/tz/art/2026/art_iot.html" target="_blank" title="工业和信息化部办公厅关于印发《工业互联网与油气储运行业融合应用参考指南（2026年）》的通知">工业和信息化部办公厅关于印发《工业互联网与油气储运行业融合应用参考指南（2026年）》的通知</a><span>2026-05-21</span>
        </p>
      </li>
      <li><span>2026-05-25</span><p><a href="/gxsj/tjfx/txy/art/2026/art_tel.html" target="_blank" title="2026年前4个月通信业经济运行情况">2026年前4个月通信业经济运行情况</a></p></li>
      <li><span>2026-05-12</span><p><a href="/gxsj/tjfx/zbgy/qc/art/2026/art_auto.html" target="_blank" title="2026年4月汽车工业经济运行情况">2026年4月汽车工业经济运行情况</a></p></li>
      <li><span>2026-05-24</span><p><a href="http://www.miit.gov.cn/xwfb/bldhd/art/2026/art_ai.html" target="_blank" title="中国—东盟人工智能产业创新中心成立">中国—东盟人工智能产业创新中心成立</a></p></li>
      <li>
        <p>
          <a href="/zwgk/wjgs/art/2026/art_standard.html" target="_blank" title="关于公开征求《工业互联网平台 工业知识智能计算技术要求》行业标准报批意见的公示">关于公开征求《工业互联网平台 工业知识智能计算技术要求》行业标准报批意见的公示</a><span>2026-05-22</span>
        </p>
      </li>
    </ul>
  </body>
</html>
`;

test("MiitOfficialProvider parses official MIIT homepage policy and industry items", () => {
  const items = MiitOfficialProvider.parseHomepageItems(miitHomepageHtml, "https://www.miit.gov.cn/index.html");

  assert.equal(items.length, 6);
  assert.equal(items[0]?.title, "工业和信息化部公告 《电器电子产品有害物质限制使用达标管理目录（2026年版）》");
  assert.equal(items[0]?.published_at, "2026-05-28");
  assert.equal(items[0]?.category, "policy_file");
  assert.equal(items[0]?.url, "https://www.miit.gov.cn/zwgk/zcwj/wjfb/gg/art/2026/art_1abc.html");
  assert.equal(items[4]?.url, "https://www.miit.gov.cn/xwfb/bldhd/art/2026/art_ai.html");
  assert.equal(items[5]?.category, "public_consultation");
});

test("MiitOfficialProvider returns official industry-policy evidence without advice", async () => {
  const fetchImpl = (async () =>
    new Response(miitHomepageHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new MiitOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "012414",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false,
    context: {
      fund_code: "012414",
      fund_name: "数字经济制造精选混合",
      fund_type: "mixed",
      themes: ["工业互联网", "人工智能", "通信"]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "miit-official");
  assert.equal(result.source_type, "policy");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("工业互联网与油气储运")));
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("通信业经济运行情况")));
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("工业和信息化部/")));
  assert.ok(result.warnings.some((warning) => warning.includes("不能直接补齐单只基金核心证据")));
  assert.match(result.raw_reference ?? "", /miit\.gov\.cn\/index\.html/);
  assert.doesNotMatch(JSON.stringify(result), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("MiitOfficialProvider falls back to latest official items when context is absent", async () => {
  const fetchImpl = (async () =>
    new Response(miitHomepageHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new MiitOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("电器电子产品有害物质限制使用")));
  assert.ok(result.warnings.some((warning) => warning.includes("返回最新工信部发布作为弱产业背景")));
});

test("MiitOfficialProvider fails explicitly when the official homepage is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new MiitOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("工业和信息化部官网首页返回 HTTP 403")));
  assert.equal(result.raw_reference, "https://www.miit.gov.cn/index.html");
});

test("Argus preserves MIIT industry evidence without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(miitHomepageHtml, {
      status: 200,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new MiitOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("miit-policy-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.policy_signals.some((signal) => signal.includes("电器电子产品有害物质限制使用")));
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("工业和信息化部")));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "miit-official" && source.record_count === 5));
});
