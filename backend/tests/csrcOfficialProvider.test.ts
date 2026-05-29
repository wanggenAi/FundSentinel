import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { CsrcOfficialProvider, SourceRegistry } from "../src/dataSources/index.js";

const csrcSearchListJson = JSON.stringify({
  data: {
    channelId: "a1a078ee0bc54721ab6b148884c784a8",
    channelName: "证监会要闻",
    total: 3,
    results: [
      {
        title: "证监会严肃查处老虎等机构非法跨境展业案件",
        url: "//www.csrc.gov.cn/csrc/c100028/c7634330/content.shtml",
        publishedTimeStr: "2026-05-22 14:42:33",
        channelName: "证监会要闻",
        memo: "境内外相关主体未经核准在境内开展证券交易营销推广、处理交易指令等相关证券业务服务。",
        domainMetaList: [
          {
            domainMetadataName: "基本元数据集",
            resultList: [
              { name: "来源", key: "infosource", value: "证监会" },
              { name: "部门", key: "section", value: "办公厅（党委办公室）" }
            ]
          }
        ]
      },
      {
        title: "中国证监会有关部门负责人就《综合整治非法跨境证券期货基金经营活动实施方案》答记者问",
        url: "//www.csrc.gov.cn/csrc/c100028/c7634328/content.shtml",
        publishedTimeStr: "2026-05-22 16:19:43",
        channelName: "证监会要闻",
        memo: "防范和打击非法跨境证券期货基金经营活动，保护投资者合法权益。",
        domainMetaList: [
          {
            domainMetadataName: "基本元数据集",
            resultList: [{ name: "来源", key: "infosource", value: "证监会" }]
          }
        ]
      },
      {
        title: "国务院任命证监会有关负责人",
        url: "//www.csrc.gov.cn/csrc/c100028/c7629416/content.shtml",
        publishedTimeStr: "2026-04-29 15:34:28",
        channelName: "证监会要闻",
        memo: "国务院决定，任命刘浩凌为中国证券监督管理委员会副主席。"
      }
    ]
  },
  channelName: "证监会要闻"
});

test("CsrcOfficialProvider parses official searchList releases", () => {
  const parsed = CsrcOfficialProvider.parseSearchList(
    csrcSearchListJson,
    "https://www.csrc.gov.cn/searchList/a1a078ee0bc54721ab6b148884c784a8?_isAgg=true&_isJson=true&page=1"
  );

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.title, "证监会严肃查处老虎等机构非法跨境展业案件");
  assert.equal(parsed[0]?.published_at, "2026-05-22");
  assert.equal(parsed[0]?.url, "https://www.csrc.gov.cn/csrc/c100028/c7634330/content.shtml");
  assert.equal(parsed[0]?.channel_name, "证监会要闻");
  assert.equal(parsed[0]?.source_name, "证监会");
  assert.ok(parsed[0]?.summary?.includes("证券交易营销推广"));
});

test("CsrcOfficialProvider returns official regulatory evidence without advice", async () => {
  const fetchImpl = (async () =>
    new Response(csrcSearchListJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new CsrcOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "164906",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false,
    context: {
      fund_code: "164906",
      fund_name: "交银中证海外中国互联网指数QDII",
      fund_type: "QDII",
      themes: ["海外", "跨境", "基金"]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "csrc-official");
  assert.equal(result.source_type, "policy");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("非法跨境证券期货基金")));
  assert.ok(result.data?.news_summaries?.[0]?.includes("证监会"));
  assert.ok(result.warnings.some((warning) => warning.includes("不能直接补齐单只基金核心证据")));
  assert.match(result.raw_reference ?? "", /csrc\.gov\.cn\/searchList/);
  assert.doesNotMatch(JSON.stringify(result.data), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("CsrcOfficialProvider falls back to latest regulatory releases when context is absent", async () => {
  const fetchImpl = (async () =>
    new Response(csrcSearchListJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const result = await new CsrcOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("非法跨境展业")));
  assert.ok(result.warnings.some((warning) => warning.includes("返回最新证监会发布作为弱监管背景")));
});

test("CsrcOfficialProvider fails explicitly when official endpoint is unavailable", async () => {
  const fetchImpl = (async () =>
    new Response("forbidden", {
      status: 403,
      headers: { "content-type": "text/html" }
    })) as typeof fetch;

  const result = await new CsrcOfficialProvider(fetchImpl, 1000).fetch({
    fund_code: "007951",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(result.warnings.some((warning) => warning.includes("中国证监会 searchList 官方接口返回 HTTP 403")));
  assert.match(result.raw_reference ?? "", /csrc\.gov\.cn\/searchList/);
});

test("Argus preserves CSRC regulatory evidence without allowing core fund analysis", async () => {
  const fetchImpl = (async () =>
    new Response(csrcSearchListJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new CsrcOfficialProvider(fetchImpl, 1000)],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("csrc-regulatory-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.policy_signals.some((signal) => signal.includes("非法跨境展业")));
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("证监会")));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "csrc-official" && source.record_count === 3));
});
