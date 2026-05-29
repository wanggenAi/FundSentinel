import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FundDataPack, TrendStatus } from "../schemas/index.js";
import { clamp } from "../schemas/index.js";

export class VegaAgent extends BaseAgent {
  readonly name = "Vega";
  readonly role = "Turning Point Signal Agent";
  readonly responsibilities = [
    "判断止跌、企稳、趋势改善、转弱或破位信号",
    "为首页策略触发和采基广场状态判断提供趋势评分",
    "避免把短期反弹误判为确定性上涨"
  ];

  async run(taskId: string, dataPack: FundDataPack): Promise<AgentResult> {
    const aiResponse = await this.askAI({
      taskId,
      fundCode: dataPack.fund_code,
      prompt: "Review turning-point signals. Be conservative about short-term rebounds.",
      context: {
        nav_history: dataPack.nav_history,
        daily_return: dataPack.daily_return,
        stage_returns: dataPack.stage_returns,
        data_quality: dataPack.data_quality
      }
    });
    const nav = dataPack.nav_history;
    const warnings: string[] = [];
    if (!dataPack.allow_strong_conclusion) warnings.push("Argus 未允许强结论，Vega 仅输出弱趋势复核。");
    if (nav.length < 8) warnings.push("净值序列不足，拐点判断降级。");
    if (aiResponse.available && aiResponse.content) warnings.push("已调用统一 AI API 辅助审阅；V0.1 仍以结构化规则输出为准。");

    let trendStatus: TrendStatus = "stabilizing";
    let score = 50;
    const metrics: Record<string, unknown> = { nav_points: nav.length };
    if (nav.length >= 5) {
      const recent = nav.slice(-5);
      const previous = nav.length >= 10 ? nav.slice(-10, -5) : nav.slice(0, -5);
      const recentReturn = recent[0] ? recent.at(-1)! / recent[0] - 1 : 0;
      const recentLow = Math.min(...recent);
      const previousLow = previous.length ? Math.min(...previous) : recentLow;
      const shortMa = mean(nav.slice(-3));
      const midMa = nav.length >= 8 ? mean(nav.slice(-8)) : mean(nav);
      const noNewLow = recentLow >= previousLow;
      const maImproving = shortMa >= midMa;

      score = 38 + recentReturn * 450 + (noNewLow ? 18 : 0) + (maImproving ? 18 : 0);
      if (recentReturn < -0.02 && !noNewLow) trendStatus = "falling";
      else if (noNewLow && maImproving && recentReturn > 0.01) trendStatus = "improving";
      else if (noNewLow) trendStatus = "stabilizing";
      else trendStatus = "weakening";
      Object.assign(metrics, {
        recent_return: Number(recentReturn.toFixed(4)),
        short_ma: Number(shortMa.toFixed(4)),
        mid_ma: Number(midMa.toFixed(4)),
        no_new_low: noNewLow,
        ma_improving: maImproving
      });
    }
    score = clamp(score);
    if (warnings.length) score = Math.min(score, 58);

    const evidence: EvidenceItem[] = [
      {
        title: "短期趋势信号",
        source_name: dataPack.is_mock ? "Demo NAV history" : "Argus NAV history",
        source_type: "industry_data",
        trust_level: dataPack.is_mock ? "C" : "B",
        summary: `趋势状态为 ${trendStatus}，仅代表净值序列中的技术信号。`,
        importance_score: 0.7,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      }
    ];

    return this.buildResult({
      taskId,
      fundCode: dataPack.fund_code,
      status: score >= 45 && warnings.length === 0 ? "success" : "warning",
      score: Number(score.toFixed(2)),
      confidence: !dataPack.allow_strong_conclusion ? Math.min(nav.length >= 10 ? 0.68 : 0.42, 0.55) : nav.length >= 10 ? 0.68 : 0.42,
      summary: `拐点评分 ${score.toFixed(1)}，趋势状态 ${trendStatus}。`,
      evidence,
      metrics: { ...metrics, trend_status: trendStatus, ai_gateway_available: aiResponse.available, ai_model: aiResponse.model },
      warnings,
      nextSuggestions: ["后续接入成交、规模变化、同类指数和市场宽度信号。"],
      isMock: dataPack.is_mock
    });
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
