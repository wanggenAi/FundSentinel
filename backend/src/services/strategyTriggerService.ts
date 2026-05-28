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
        trigger_type: this.triggerTypeForAction(action),
        priority: this.priorityForAction(action, analysis.final_decision.risk_level),
        reason: analysis.final_decision.summary,
        suggested_action: this.suggestedAction(action),
        related_agent: ["reduce", "exit", "avoid"].includes(action) ? "Atlas" : "Aegis",
        is_mock: true
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
        suggested_action: this.suggestedAction(analysis.final_decision.action),
        related_agent: "Atlas",
        is_mock: true
      }));
  }

  buildTodayFocus(triggers: StrategyTrigger[]): TodayFocusItem[] {
    const highPriority = triggers.filter((trigger) => trigger.priority === "high");
    const trialOrAdd = triggers.filter((trigger) => ["trial_buy", "add_position"].includes(trigger.trigger_type));
    const focus: TodayFocusItem[] = [
      {
        title: "先看风险，再看机会",
        summary: "首页所有策略触发均来自 mock 多 Agent 分析，请优先确认风险提示与失效条件。",
        priority: highPriority.length ? "high" : "medium",
        related_funds: highPriority.slice(0, 3).map((trigger) => trigger.fund_code),
        is_mock: true
      }
    ];
    if (trialOrAdd.length) {
      focus.push({
        title: "存在可研究的试探机会",
        summary: "仅代表观察或小仓位验证信号，不代表保证收益或真实交易指令。",
        priority: "medium",
        related_funds: trialOrAdd.slice(0, 3).map((trigger) => trigger.fund_code),
        is_mock: true
      });
    }
    return focus;
  }

  private triggerTypeForAction(action: StrategyAction): TriggerType {
    const map: Record<StrategyAction, TriggerType> = {
      avoid: "risk_warning",
      observe: "observe",
      trial_buy: "trial_buy",
      staged_buy: "add_position",
      hold: "observe",
      reduce: "reduce",
      exit: "exit"
    };
    return map[action];
  }

  private priorityForAction(action: StrategyAction, riskLevel: string): TriggerPriority {
    if (["exit", "reduce", "avoid"].includes(action) || riskLevel === "high") return "high";
    if (["trial_buy", "staged_buy"].includes(action)) return "medium";
    return "low";
  }

  private suggestedAction(action: StrategyAction): string {
    const map: Record<StrategyAction, string> = {
      avoid: "暂停操作，等待证据修复或风险释放。",
      observe: "加入观察，不追高，不扩大仓位。",
      trial_buy: "仅适合小仓位试探，并设置失效条件。",
      staged_buy: "可研究分批买入方案，但必须控制单次仓位。",
      hold: "维持持有，跟踪策略条件是否变化。",
      reduce: "研究降低仓位，避免风险继续扩大。",
      exit: "研究退出条件，避免无证据持有。"
    };
    return map[action];
  }
}

