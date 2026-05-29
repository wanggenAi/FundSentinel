import { BaseAgent } from "./base.js";
import type { AgentResult, EvidenceItem, FundDataPack } from "../schemas/index.js";
import { clamp } from "../schemas/index.js";

export class LogosAgent extends BaseAgent {
  readonly name = "Logos";
  readonly role = "Industry Logic Analyst Agent";
  readonly responsibilities = [
    "判断基金主题背后的行业硬逻辑",
    "区分政策、官方、基金报告、新闻和社交情绪的证据权重",
    "避免把论坛情绪作为核心证据"
  ];

  async run(taskId: string, dataPack: FundDataPack): Promise<AgentResult> {
    const aiResponse = await this.askAI({
      taskId,
      fundCode: dataPack.fund_code,
      prompt: "Review industry logic evidence. Return concise risks and supporting factors.",
      context: {
        themes: dataPack.themes,
        policy_signals: dataPack.policy_signals,
        macro_indicators: dataPack.macro_indicators,
        portfolio_holdings: dataPack.portfolio_holdings,
        news_summaries: dataPack.news_summaries,
        data_quality: dataPack.data_quality
      }
    });
    const score = clamp(
      Math.min(dataPack.policy_signals.length * 18, 45) +
        Math.min(dataPack.portfolio_holdings.length * 10, 25) +
        Math.min(dataPack.themes.length * 8, 20) +
        Math.min(dataPack.news_summaries.length * 4, 10)
    );
    const warnings: string[] = [];
    if (dataPack.policy_signals.length === 0) warnings.push("缺少政策或官方方向证据，硬逻辑判断降级。");
    if (dataPack.social_sentiment_score > 0.7) warnings.push("社交情绪偏热，仅作为辅助观察，不作为核心证据。");
    if (aiResponse.available && aiResponse.content) warnings.push("已调用统一 AI API 辅助审阅；V0.1 仍以结构化规则输出为准。");

    const evidence: EvidenceItem[] = [
      ...dataPack.policy_signals.slice(0, 2).map((signal) => ({
        title: `政策方向：${signal}`,
        source_name: dataPack.is_mock ? "Demo policy digest" : "Argus policy evidence",
        source_type: "policy" as const,
        trust_level: dataPack.is_mock ? ("B" as const) : ("A" as const),
        summary: `${signal} 与基金主题 ${dataPack.themes.slice(0, 2).join(", ")} 存在关联。`,
        importance_score: 0.82,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      })),
      ...dataPack.news_summaries.slice(0, 1).map((news) => ({
        title: "产业新闻摘要",
        source_name: dataPack.is_mock ? "Demo industry news" : "Argus industry evidence",
        source_type: "news" as const,
        trust_level: "C" as const,
        summary: news,
        importance_score: 0.55,
        related_theme: dataPack.themes[0] ?? null,
        published_at: null,
        url: null,
        is_mock: dataPack.is_mock
      }))
    ];

    return this.buildResult({
      taskId,
      fundCode: dataPack.fund_code,
      status: score >= 60 ? "success" : "warning",
      score: Number(score.toFixed(2)),
      confidence: score >= 60 ? 0.72 : 0.52,
      summary: `硬逻辑评分 ${score.toFixed(1)}，核心主题为 ${dataPack.themes.join(", ")}。`,
      evidence,
      metrics: {
        policy_signal_count: dataPack.policy_signals.length,
        macro_indicator_count: dataPack.macro_indicators.length,
        holding_match_count: dataPack.portfolio_holdings.length,
        social_sentiment_score: dataPack.social_sentiment_score,
        ai_gateway_available: aiResponse.available,
        ai_model: aiResponse.model
      },
      warnings,
      nextSuggestions: ["后续接入基金季报持仓、产业数据和官方政策原文进行交叉验证。"],
      isMock: dataPack.is_mock
    });
  }
}
