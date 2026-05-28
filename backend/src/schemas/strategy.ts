import type { TriggerPriority, TriggerType } from "./common.js";

export interface StrategyTrigger {
  fund_code: string;
  fund_name: string;
  trigger_type: TriggerType;
  priority: TriggerPriority;
  reason: string;
  suggested_action: string;
  related_agent: string;
  is_mock: boolean;
}

export interface HoldingAlert {
  fund_code: string;
  fund_name: string;
  alert_type: string;
  priority: TriggerPriority;
  summary: string;
  suggested_action: string;
  related_agent: string;
  is_mock: boolean;
}

export interface TodayFocusItem {
  title: string;
  summary: string;
  priority: TriggerPriority;
  related_funds: string[];
  is_mock: boolean;
}

