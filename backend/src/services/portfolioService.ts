import { createHash } from "node:crypto";
import { readFileSync, statSync, type Stats } from "node:fs";
import type { PortfolioHolding, PortfolioSnapshot } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";
import { MockDataService } from "./mockDataService.js";

export interface PortfolioServiceOptions {
  portfolioFile?: string | null;
  demoMode?: boolean;
  now?: () => string;
}

export class PortfolioService {
  private readonly portfolioFile: string | null;
  private readonly demoMode: boolean;
  private readonly now: () => string;

  constructor(
    private readonly mockDataService = new MockDataService(),
    options: PortfolioServiceOptions = {}
  ) {
    const configuredPortfolioFile = options.portfolioFile === undefined ? process.env.FUNDSENTINEL_PORTFOLIO_FILE : options.portfolioFile;
    this.portfolioFile = this.normalizeConfiguredPath(configuredPortfolioFile);
    this.demoMode = options.demoMode ?? process.env.FUNDSENTINEL_DEMO_MODE === "true";
    this.now = options.now ?? nowIso;
  }

  getPortfolioSnapshot(userId = "mock-user"): PortfolioSnapshot {
    if (this.portfolioFile) return this.getManualPortfolioSnapshot(userId, this.portfolioFile);
    if (this.demoMode) return this.mockDataService.getPortfolioSnapshot(userId);

    return this.emptySnapshot(userId, "PortfolioService", [
      "首页持仓未配置真实来源；设置 FUNDSENTINEL_PORTFOLIO_FILE 指向经用户确认的本地 JSON 后才会展示真实持仓。",
      "未使用 MockDataService；本地演示需显式设置 FUNDSENTINEL_DEMO_MODE=true。"
    ]);
  }

  private getManualPortfolioSnapshot(userId: string, filePath: string): PortfolioSnapshot {
    try {
      const fileBuffer = readFileSync(filePath);
      const fileStats = statSync(filePath);
      const parsed = JSON.parse(fileBuffer.toString("utf8").replace(/^\uFEFF/u, "")) as unknown;
      return this.parseManualPortfolioSnapshot(userId, filePath, fileBuffer, fileStats, parsed);
    } catch (error) {
      return this.emptySnapshot(userId, `ManualPortfolioJsonProvider:${filePath}`, [
        `手动持仓文件不可用：${this.errorMessage(error)}`,
        "未回退到 mock 持仓；请修复 FUNDSENTINEL_PORTFOLIO_FILE，或仅在本地演示时设置 FUNDSENTINEL_DEMO_MODE=true。"
      ]);
    }
  }

  private parseManualPortfolioSnapshot(userId: string, filePath: string, fileBuffer: Buffer, fileStats: Stats, parsed: unknown): PortfolioSnapshot {
    if (!this.isRecord(parsed)) throw new Error("Portfolio JSON root must be an object.");
    if (!Array.isArray(parsed.holdings)) throw new Error("Portfolio JSON must include holdings array.");

    const importedAt = this.now();
    const generatedAt = typeof parsed.generated_at === "string" && parsed.generated_at.trim() ? parsed.generated_at : importedAt;
    const baseWarnings = [
      "手动持仓 JSON 是用户/运营维护的真实数据 workaround；不代表券商、银行或支付账户自动连接。",
      `file_sha256=${createHash("sha256").update(fileBuffer).digest("hex")}`,
      `file_size_bytes=${fileStats.size}`,
      `file_mtime=${fileStats.mtime.toISOString()}`,
      `imported_at=${importedAt}`
    ];
    if (generatedAt === importedAt) baseWarnings.push("手动持仓文件未提供 generated_at，已使用导入时间。");
    if (typeof parsed.user_id === "string" && parsed.user_id.trim() && parsed.user_id !== userId) {
      baseWarnings.push(`手动持仓文件 user_id=${parsed.user_id}，当前请求 user_id=${userId}；V0.1 未实现账户连接或多账户鉴权。`);
    }

    const holdings = parsed.holdings.map((item, index) => this.parseManualHolding(item, index));
    if (!holdings.length) {
      return this.emptySnapshot(userId, `ManualPortfolioJsonProvider:${filePath}`, ["手动持仓文件已读取，但 holdings 为空。", ...baseWarnings], generatedAt);
    }

    const totalAssets = this.round(holdings.reduce((sum, holding) => sum + holding.holding_amount, 0), 2);
    const dailyPnl = this.round(holdings.reduce((sum, holding) => sum + holding.daily_pnl, 0), 2);
    return {
      user_id: userId,
      total_assets: totalAssets,
      daily_pnl: dailyPnl,
      daily_pnl_ratio: totalAssets > 0 ? this.round(dailyPnl / totalAssets, 5) : 0,
      holdings: holdings.map((holding) => ({
        ...holding,
        weight: totalAssets > 0 ? this.round(holding.holding_amount / totalAssets, 4) : 0
      })),
      data_quality: {
        level: "medium",
        score: 0.68,
        source: `ManualPortfolioJsonProvider:${filePath}`,
        updated_at: generatedAt,
        warnings: baseWarnings,
        is_mock: false
      },
      generated_at: generatedAt,
      is_mock: false
    };
  }

  private parseManualHolding(item: unknown, index: number): PortfolioHolding {
    if (!this.isRecord(item)) throw new Error(`Portfolio holding ${index + 1} must be an object.`);
    const fundCode = this.requiredString(item, "fund_code", index);
    if (!/^\d{6}$/.test(fundCode)) throw new Error(`Portfolio holding ${index + 1} has invalid fund_code.`);

    const fundName = this.requiredString(item, "fund_name", index);
    const holdingAmount = this.requiredPositiveNumber(item, "holding_amount", index);
    const costNav = this.requiredPositiveNumber(item, "cost_nav", index);
    const currentNav = this.requiredPositiveNumber(item, "current_nav", index);
    const dailyPnl = this.optionalNumber(item, "daily_pnl") ?? 0;
    const unrealizedPnlRatio = this.optionalNumber(item, "unrealized_pnl_ratio") ?? (currentNav - costNav) / costNav;

    return {
      fund_code: fundCode,
      fund_name: fundName,
      holding_amount: this.round(holdingAmount, 2),
      cost_nav: this.round(costNav, 4),
      current_nav: this.round(currentNav, 4),
      daily_pnl: this.round(dailyPnl, 2),
      unrealized_pnl_ratio: this.round(unrealizedPnlRatio, 4),
      weight: 0,
      is_mock: false
    };
  }

  private emptySnapshot(userId: string, source: string, warnings: string[], generatedAt = this.now()): PortfolioSnapshot {
    return {
      user_id: userId,
      total_assets: 0,
      daily_pnl: 0,
      daily_pnl_ratio: 0,
      holdings: [],
      data_quality: {
        level: "low",
        score: 0,
        source,
        updated_at: generatedAt,
        warnings,
        is_mock: false
      },
      generated_at: generatedAt,
      is_mock: false
    };
  }

  private normalizeConfiguredPath(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private requiredString(record: Record<string, unknown>, field: string, index: number): string {
    const value = record[field];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Portfolio holding ${index + 1} missing ${field}.`);
    return value.trim();
  }

  private requiredPositiveNumber(record: Record<string, unknown>, field: string, index: number): number {
    const value = this.optionalNumber(record, field);
    if (value === undefined || value <= 0) throw new Error(`Portfolio holding ${index + 1} has invalid ${field}.`);
    return value;
  }

  private optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === "") return undefined;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
    if (!Number.isFinite(value)) throw new Error(`Portfolio holding has invalid ${field}.`);
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private round(value: number, digits: number): number {
    return Number(value.toFixed(digits));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
