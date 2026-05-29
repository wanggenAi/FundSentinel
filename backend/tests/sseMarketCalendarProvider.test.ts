import assert from "node:assert/strict";
import test from "node:test";
import { ArgusAgent } from "../src/agents/index.js";
import { SourceRegistry, SseMarketCalendarProvider } from "../src/dataSources/index.js";

const ipoJsonp = `jsonpCallback({
  "result": [
    {
      "stockCode": "688001",
      "stockAbbr": "华兴科技",
      "bizType": "1",
      "bizTypeDesc": "IPO",
      "subTypeDesc": "网上申购",
      "title": "华兴科技网上申购",
      "tradeBeginDate": "20260529"
    }
  ],
  "pageHelp": { "total": 1, "pageNo": 1, "pageSize": 25 }
})`;

const roadshowJson = JSON.stringify({
  result: [
    {
      stockCode: "688002",
      stockAbbr: "海云数据",
      bizType: "2",
      title: "海云数据首次公开发行网上路演",
      tradeBeginDate: "20260529"
    }
  ]
});

const meetingJsonp = `jsonpCallback({
  "result": [
    {
      "SEC_CODE": "600008",
      "SEC_NAME_CN": "首创环保",
      "CONVENE_DATE": "20260529",
      "CONVENE_SITE_DATE": "20260529",
      "ID": "meeting-1"
    }
  ],
  "pageHelp": { "total": 1 }
})`;

test("SseMarketCalendarProvider parses SSE calendar JSONP events", () => {
  const events = SseMarketCalendarProvider.parseCalendarResponse(ipoJsonp, "ipo", "https://query.sse.com.cn/commonSoaQuery.do");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "ipo");
  assert.equal(events[0]?.event_date, "2026-05-29");
  assert.equal(events[0]?.security_code, "688001");
  assert.equal(events[0]?.security_name, "华兴科技");
  assert.equal(events[0]?.title, "华兴科技网上申购");
  assert.equal(events[0]?.source_name, "上海证券交易所");
});

test("SseMarketCalendarProvider parses SSE shareholder meeting JSONP", () => {
  const events = SseMarketCalendarProvider.parseShareholderMeetingResponse(meetingJsonp, "https://query.sse.com.cn/commonQuery.do");

  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_type, "shareholder_meeting");
  assert.equal(events[0]?.event_date, "2026-05-29");
  assert.equal(events[0]?.security_code, "600008");
  assert.ok(events[0]?.title.includes("股东会"));
});

test("SseMarketCalendarProvider returns official market events without advice", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("bizType=1")) return new Response(ipoJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    if (target.includes("bizType=2")) return new Response(roadshowJson, { status: 200, headers: { "content-type": "application/json" } });
    if (target.includes("COMMON_SSE_SCFW_TZZFW_GDDHWLTPZL_L")) {
      return new Response(meetingJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await new SseMarketCalendarProvider(fetchImpl, 1000, "20260529").fetch({
    fund_code: "007951",
    required_data: ["industry_news", "policy_evidence"],
    demo_mode: false
  });

  assert.equal(result.success, true);
  assert.equal(result.source_id, "sse-szse-official");
  assert.equal(result.source_type, "news");
  assert.equal(result.trust_level, "A");
  assert.equal(result.is_demo, false);
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("华兴科技网上申购")));
  assert.ok(result.data?.news_summaries?.some((summary) => summary.includes("首创环保")));
  assert.match(result.raw_reference ?? "", /sse\.com\.cn\/disclosure\/dealinstruc\/calendar/);
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资建议或买卖结论")));
  assert.doesNotMatch(JSON.stringify(result), /trial_buy|staged_buy|\b(buy|sell)\b/i);
});

test("SseMarketCalendarProvider fails explicitly when all official calendar endpoints fail", async () => {
  const fetchImpl = (async () => new Response("gateway error", { status: 502, headers: { "content-type": "text/plain" } })) as typeof fetch;

  const result = await new SseMarketCalendarProvider(fetchImpl, 1000, "20260529").fetch({
    fund_code: "007951",
    required_data: ["industry_news"],
    demo_mode: false
  });

  assert.equal(result.success, false);
  assert.equal(result.data_status, "unavailable");
  assert.match(result.error ?? "", /HTTP 502/);
  assert.ok(result.warnings.some((warning) => warning.includes("上交所官方市场日历接口未返回可用事件")));
});

test("Argus preserves SSE market events without allowing core fund analysis", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.includes("bizType=1")) return new Response(ipoJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    if (target.includes("bizType=2")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
    if (target.includes("COMMON_SSE_SCFW_TZZFW_GDDHWLTPZL_L")) {
      return new Response(meetingJsonp, { status: 200, headers: { "content-type": "text/javascript" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const registry = new SourceRegistry({
    providers: [new SseMarketCalendarProvider(fetchImpl, 1000, "20260529")],
    cacheTtlMs: 0,
    retryCount: 0
  });

  const { dataPack } = await new ArgusAgent(registry).prepareDataPack("sse-market-calendar-flow", "007951");

  assert.equal(dataPack.data_status, "insufficient");
  assert.equal(dataPack.allow_downstream_analysis, false);
  assert.ok(dataPack.news_summaries.some((summary) => summary.includes("上海证券交易所/市场日历")));
  assert.ok(dataPack.data_sources.some((source) => source.source_id === "sse-szse-official" && source.record_count === 2));
});
