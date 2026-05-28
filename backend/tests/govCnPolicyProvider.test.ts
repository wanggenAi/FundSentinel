import assert from "node:assert/strict";
import test from "node:test";
import { GovCnPolicyProvider } from "../src/dataSources/index.js";

const policyJson = JSON.stringify([
  {
    TITLE: "中共中央办公厅 国务院办公厅印发《碳达峰碳中和综合评价考核办法》",
    URL: "https://www.gov.cn/zhengce/202604/content_7066695.htm",
    DOCRELPUBTIME: "2026-04-23"
  },
  {
    TITLE: "国务院关于印发《城市更新“十五五”规划》的通知",
    URL: "https://www.gov.cn/zhengce/content/202605/content_7070539.htm",
    DOCRELPUBTIME: "2026-05-28"
  },
  {
    TITLE: "国务院关于推行常住地提供基本公共服务的实施意见",
    URL: "https://www.gov.cn/zhengce/content/202605/content_7069960.htm",
    DOCRELPUBTIME: "2026-05-22"
  }
]);

test("Gov.cn policy parser reads official latest policy JSON", () => {
  const parsed = GovCnPolicyProvider.parsePolicyList(policyJson);

  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.TITLE, "中共中央办公厅 国务院办公厅印发《碳达峰碳中和综合评价考核办法》");
});

test("Gov.cn policy provider returns official policy signals without advice", async () => {
  const fetchImpl = (async () =>
    new Response(policyJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const provider = new GovCnPolicyProvider(fetchImpl, 1000);
  const result = await provider.fetch({
    fund_code: "012414",
    required_data: ["policy_evidence", "industry_news"],
    demo_mode: false,
    context: {
      fund_code: "012414",
      fund_name: "新能源产业优选混合",
      themes: ["新能源", "储能"]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.is_demo, false);
  assert.equal(result.source_id, "gov-cn-policy");
  assert.equal(result.trust_level, "A");
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("碳达峰碳中和")));
  assert.ok(result.warnings.some((warning) => warning.includes("不代表单只基金投资结论")));
  assert.match(result.raw_reference ?? "", /www\.gov\.cn/);
});

test("Gov.cn policy provider does not infer stale mock themes from fund code", async () => {
  const fetchImpl = (async () =>
    new Response(policyJson, {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

  const provider = new GovCnPolicyProvider(fetchImpl, 1000);
  const result = await provider.fetch({
    fund_code: "012414",
    required_data: ["policy_evidence"],
    demo_mode: false,
    context: {
      fund_code: "012414",
      fund_name: "招商中证白酒指数(LOF)C",
      themes: ["白酒", "消费"]
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.policy_signals?.some((signal) => signal.includes("碳达峰碳中和")), false);
  assert.ok(result.data?.policy_signals?.some((signal) => signal.includes("基本公共服务")));
});
