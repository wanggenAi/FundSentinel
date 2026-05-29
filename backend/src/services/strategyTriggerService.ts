import type {
  FundAnalysisResponse,
  HoldingAlert,
  StrategyAction,
  StrategyTrigger,
  TodayFocusItem,
  TriggerPriority,
  TriggerType
} from "../schemas/index.js";

export class StrategyTriggerService {
  buildTriggers(analyses: FundAnalysisResponse[]): StrategyTrigger[] {
    return analyses.map((analysis) => {
      const action = analysis.final_decision.action;
      return {
        fund_code: analysis.fund_code,
        fund_name: analysis.fund_name,
        trigger_type: this.homeTriggerTypeForAction(action),
        priority: this.priorityForAction(action, analysis.final_decision.risk_level),
        reason: this.homeReason(analysis),
        review_next_step: this.reviewNextStep(action),
        related_agent: "Atlas",
        is_mock: analysis.is_mock
      };
    });
  }

  buildHoldingAlerts(analyses: FundAnalysisResponse[]): HoldingAlert[] {
    return analyses
      .filter((analysis) => !(analysis.final_decision.risk_level === "low" && ["hold", "staged_buy"].includes(analysis.final_decision.action)))
      .map((analysis) => ({
        fund_code: analysis.fund_code,
        fund_name: analysis.fund_name,
        alert_type: "strategy_review",
        priority: this.priorityForAction(analysis.final_decision.action, analysis.final_decision.risk_level),
        summary: analysis.final_decision.risk_warnings[0] ?? "需要继续观察风险变化。",
        review_next_step: this.reviewNextStep(analysis.final_decision.action),
        related_agent: "Atlas",
        is_mock: analysis.is_mock
      }));
  }

  buildTodayFocus(triggers: StrategyTrigger[]): TodayFocusItem[] {
    if (!triggers.length) return [];
    const highPriority = triggers.filter((trigger) => trigger.priority === "high");
    const isMock = triggers.every((trigger) => trigger.is_mock);
    const focus: TodayFocusItem[] = [
      {
        title: "先看风险，再看证据",
        summary: isMock ? "当前焦点来自显式 demo 数据，仅用于本地演示或测试。" : "当前焦点来自 Atlas 审阅结果；首页只展示观察与风险复核，不输出交易动作。",
        priority: highPriority.length ? "high" : "medium",
        related_funds: highPriority.slice(0, 3).map((trigger) => trigger.fund_code),
        is_mock: isMock
      }
    ];
    if (highPriority.length) {
      focus.push({
        title: "高优先级风险复核",
        summary: "先核对数据来源、风险提示和失效条件；缺口未修复前不形成策略动作。",
        priority: "high",
        related_funds: highPriority.slice(0, 3).map((trigger) => trigger.fund_code),
        is_mock: isMock
      });
    }
    return focus;
  }

  private homeTriggerTypeForAction(action: StrategyAction): TriggerType {
    if (["avoid", "reduce", "exit"].includes(action)) return "risk_warning";
    return "observe";
  }

  private homeReason(analysis: FundAnalysisResponse): string {
    if (!analysis.data_pack.allow_downstream_analysis) return "真实核心数据不足，首页仅展示数据缺口与风险复核。";
    if (analysis.final_decision.risk_level === "high") return "Atlas 标记为高风险复核项，需先核对证据链和失效条件。";
    return "Atlas 已完成审阅；首页仅纳入观察清单，详细依据以基金分析页证据链为准。";
  }

  private priorityForAction(action: StrategyAction, riskLevel: string): TriggerPriority {
    if (["exit", "reduce", "avoid"].includes(action) || riskLevel === "high") return "high";
    if (["trial_buy", "staged_buy"].includes(action)) return "medium";
    return "low";
  }

  private reviewNextStep(action: StrategyAction): string {
    const map: Record<StrategyAction, string> = {
      avoid: "暂停形成策略结论，等待证据修复或风险释放。",
      observe: "加入观察清单，继续核对来源、估值和失效条件。",
      trial_buy: "仅记录为观察主题，先完成来源复核和情景验证。",
      staged_buy: "仅记录为观察主题，先完成来源复核和情景验证。",
      hold: "持续观察，跟踪策略条件是否变化。",
      reduce: "进入风险复核，先确认风险是否继续扩大。",
      exit: "进入风险复核，先确认证据是否仍然有效。"
    };
    return map[action];
  }
}
