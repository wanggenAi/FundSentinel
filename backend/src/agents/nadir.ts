import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FundDataPack } from "../schemas/index.js";
import { clamp } from "../schemas/index.js";

export class NadirAgent extends BaseAgent {
  readonly name = "Nadir";
  readonly role = "Valuation Position Agent";
  readonly responsibilities = [
    "判断基金是否处于历史相对低位",
    "计算历史分位、最大回撤、距离高点和低点",
    "为机会发现和持仓风险区间判断提供位置评分"
  ];

  async run(taskId: string, dataPack: FundDataPack): Promise<AgentResult> {
    const aiResponse = await this.askAI({
      taskId,
      fundCode: dataPack.fund_code,
      prompt: "Review valuation position metrics and point out data-quality caveats.",
      context: {
        current_nav: dataPack.current_nav,
        nav_history: dataPack.nav_history,
        stage_returns: dataPack.stage_returns,
        data_quality: dataPack.data_quality
      }
    });
    const nav = dataPack.nav_history;
    const warnings: string[] = [];
    if (!dataPack.allow_strong_conclusion) warnings.push("Argus 未允许强结论，Nadir 仅输出弱净值位置复核。");
    if (nav.length < 6) warnings.push("净值历史过短，低位判断必须降级。");
    if (aiResponse.available && aiResponse.content) warnings.push("已调用统一 AI API 辅助审阅；V0.1 仍以结构化规则输出为准。");

    const current = nav.at(-1) ?? dataPack.current_nav;
    const high = nav.length ? Math.max(...nav) : current;
    const low = nav.length ? Math.min(...nav) : current;
    const percentile = nav.length ? nav.filter((item) => item <= current).length / nav.length : 0.5;
    const distanceFromHigh = high ? (current - high) / high : 0;
    const distanceFromLow = low ? (current - low) / low : 0;
    const maxDrawdown = this.maxDrawdown(nav);

    let score = (1 - percentile) * 45 + Math.abs(Math.min(distanceFromHigh, 0)) * 80;
    if (distanceFromLow >= 0 && distanceFromLow <= 0.12) score += 18;
    score = clamp(score);
    if (nav.length < 6) score = Math.min(score, 55);

    const evidence: EvidenceItem[] = [
      {
        title: "历史净值位置",
        source_name: dataPack.is_mock ? "Demo NAV history" : "Argus NAV history",
        source_type: "industry_data",
        trust_level: dataPack.is_mock ? "C" : "B",
        summary: `当前净值分位约 ${percentile.toFixed(2)}，距离历史高点 ${(distanceFromHigh * 100).toFixed(1)}%。`,
        importance_score: 0.78,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      }
    ];

    return this.buildResult({
      taskId,
      fundCode: dataPack.fund_code,
      status: warnings.length === 0 && score >= 45 ? "success" : "warning",
      score: Number(score.toFixed(2)),
      confidence: !dataPack.allow_strong_conclusion ? Math.min(nav.length >= 10 ? 0.7 : 0.45, 0.55) : nav.length >= 10 ? 0.7 : 0.45,
      summary: `低位评分 ${score.toFixed(1)}，当前距离高点 ${(distanceFromHigh * 100).toFixed(1)}%，距离低点 ${(distanceFromLow * 100).toFixed(1)}%。`,
      evidence,
      metrics: {
        historical_percentile: Number(percentile.toFixed(4)),
        distance_from_high: Number(distanceFromHigh.toFixed(4)),
        distance_from_low: Number(distanceFromLow.toFixed(4)),
        max_drawdown: Number(maxDrawdown.toFixed(4)),
        nav_points: nav.length,
        ai_gateway_available: aiResponse.available,
        ai_model: aiResponse.model
      },
      warnings,
      nextSuggestions: ["后续接入更长周期复权净值和同类基金估值分位。"],
      isMock: dataPack.is_mock
    });
  }

  private maxDrawdown(navHistory: number[]): number {
    let peak: number | undefined;
    let maxDd = 0;
    for (const value of navHistory) {
      peak = peak === undefined ? value : Math.max(peak, value);
      maxDd = Math.min(maxDd, (value - peak) / peak);
    }
    return maxDd;
  }
}
