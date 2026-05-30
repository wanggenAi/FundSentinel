import type { DataQuality } from "./common.js";

export interface PortfolioHolding {
  fund_code: string;
  fund_name: string;
  holding_amount: number;
  cost_nav: number;
  current_nav: number;
  daily_pnl: number;
  unrealized_pnl_ratio: number;
  weight: number;
  is_mock: boolean;
}

export interface ManualPortfolioImportAudit {
  file_path: string;
  file_sha256: string;
  file_size_bytes: number;
  file_mtime: string;
  imported_at: string;
  generated_at: string;
  holding_count: number;
}

export interface PortfolioSnapshot {
  user_id: string;
  total_assets: number;
  daily_pnl: number;
  daily_pnl_ratio: number;
  holdings: PortfolioHolding[];
  data_quality: DataQuality;
  manual_import_audit?: ManualPortfolioImportAudit;
  generated_at: string;
  is_mock: boolean;
}
