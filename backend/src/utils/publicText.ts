import { isSensitiveKey, REDACTED_LOG_VALUE, redactSensitiveText } from "./safeLogging.js";

const SEPARATED_ACTION_PATTERN = /(^|[_\-\s])(buy|sell|position)(?=$|[_\-\s])/giu;
const ENCODED_PUBLIC_CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/must(?:%20|\+|\s)+buy/giu, "must review"],
  [/guaranteed(?:%20|\+|\s)*(?:returns?|profits?|income|yield|outcomes?)?/giu, "requires evidence review"],
  [/risk(?:%2d|%20|\+|-|\s)*free/giu, "risk-reviewed"],
  [/%E4%BF%9D%E8%AF%81%E6%94%B6%E7%9B%8A/giu, "风险复核"],
  [/%E6%97%A0%E9%A3%8E%E9%99%A9/giu, "风险复核"],
  [/%E5%BF%85%E9%A1%BB%E4%B9%B0%E5%85%A5|%E5%BF%85%E4%B9%B0/giu, "风险复核"],
  [/%E4%B9%B0%E5%85%A5|%E5%8D%96%E5%87%BA|%E4%BB%93%E4%BD%8D/giu, "复核"]
];

export function sanitizePublicText(value: string): string {
  return ENCODED_PUBLIC_CLAIM_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), redactSensitiveText(value))
    .replace(/trial_buy|staged_buy|add_position/giu, "observe")
    .replace(/\bmust\s+(buy|sell)\b/giu, "must review")
    .replace(/\bguaranteed(?:\s+(returns?|profits?|income|yield|outcomes?))?\b/giu, "requires evidence review")
    .replace(/\brisk[-\s]?free\b/giu, "risk-reviewed")
    .replace(/保证收益|稳赚不赔|稳赚|保本|无风险|零风险|必买|必须买入|必须卖出|必须买|必须卖/gu, "风险复核")
    .replace(/买入、卖出或仓位结论|买卖或仓位结论|买卖动作|交易动作策略|仓位策略/gu, "复核结论")
    .replace(/输出保守交易动作动作|输出保守仓位动作/gu, "输出保守复核状态")
    .replace(/买入|卖出|仓位|重仓|加仓|减仓/gu, "复核")
    .replace(SEPARATED_ACTION_PATTERN, "$1review")
    .replace(/\b(buy|sell|position)\b/giu, "review");
}

function sanitizePublicKey(key: string): string {
  return sanitizePublicText(key);
}

export function sanitizePublicStructure<T>(value: T): T {
  if (typeof value === "string") return sanitizePublicText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicStructure(item)) as T;
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [sanitizePublicKey(key), isSensitiveKey(key) ? REDACTED_LOG_VALUE : sanitizePublicStructure(entry)])
  ) as T;
}
