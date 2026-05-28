import type { DataAcquisitionPlan, DataGapReport, DataQualityLevel, DataQualityReport, FundDataPack, PortfolioSnapshot } from "../schemas/index.js";
import { nowIso } from "../schemas/index.js";

interface RawFund {
  fund_code: string;
  fund_name: string;
  fund_type: string;
  themes: string[];
  current_nav: number;
  daily_return: number;
  nav_history: number[];
  stage_returns: Record<string, number>;
  portfolio_holdings: string[];
  policy_signals: string[];
  news_summaries: string[];
  social_sentiment_score: number;
  data_quality_score: number;
  data_quality_level: DataQualityLevel;
  quality_warnings: string[];
}

export class MockDataService {
  private readonly updatedAt = nowIso();

  private readonly funds: Record<string, RawFund> = {
    "007951": {
      fund_code: "007951",
      fund_name: "中证科技先锋混合",
      fund_type: "mixed",
      themes: ["AI算力", "半导体", "数字经济"],
      current_nav: 1.284,
      daily_return: 0.0085,
      nav_history: [1.82, 1.74, 1.68, 1.57, 1.49, 1.38, 1.31, 1.26, 1.22, 1.2, 1.21, 1.23, 1.25, 1.27, 1.284],
      stage_returns: { "1w": 0.028, "1m": 0.055, "3m": -0.036, "1y": -0.184 },
      portfolio_holdings: ["半导体设备", "AI服务器", "云基础设施"],
      policy_signals: ["数字中国建设", "国产算力基础设施", "科技自立自强"],
      news_summaries: ["AI基础设施资本开支维持高位", "半导体设备国产替代订单改善"],
      social_sentiment_score: 0.58,
      data_quality_score: 0.88,
      data_quality_level: "high",
      quality_warnings: []
    },
    "161725": {
      fund_code: "161725",
      fund_name: "白酒消费精选指数",
      fund_type: "index",
      themes: ["消费", "白酒", "内需"],
      current_nav: 0.842,
      daily_return: -0.004,
      nav_history: [1.46, 1.39, 1.32, 1.21, 1.15, 1.06, 0.98, 0.91, 0.87, 0.85, 0.83, 0.835, 0.838, 0.847, 0.842],
      stage_returns: { "1w": 0.008, "1m": 0.014, "3m": -0.085, "1y": -0.256 },
      portfolio_holdings: ["高端白酒", "区域酒企", "大众消费"],
      policy_signals: ["扩大内需", "消费复苏"],
      news_summaries: ["渠道库存仍需消化", "龙头估值回到历史偏低区间"],
      social_sentiment_score: 0.43,
      data_quality_score: 0.83,
      data_quality_level: "high",
      quality_warnings: ["消费复苏斜率仍不稳定"]
    },
    "012414": {
      fund_code: "012414",
      fund_name: "新能源产业优选混合",
      fund_type: "mixed",
      themes: ["新能源", "储能", "电动车"],
      current_nav: 0.713,
      daily_return: 0.002,
      nav_history: [1.58, 1.46, 1.31, 1.17, 1.05, 0.96, 0.88, 0.79, 0.74, 0.7, 0.69, 0.695, 0.704, 0.709, 0.713],
      stage_returns: { "1w": 0.014, "1m": 0.033, "3m": -0.112, "1y": -0.341 },
      portfolio_holdings: ["储能逆变器", "动力电池", "光伏设备"],
      policy_signals: ["能源安全", "新型电力系统", "出口结构升级"],
      news_summaries: ["产业链价格竞争仍在", "储能需求增速维持但利润传导分化"],
      social_sentiment_score: 0.49,
      data_quality_score: 0.81,
      data_quality_level: "high",
      quality_warnings: ["供给出清尚未完全确认"]
    },
    "018880": {
      fund_code: "018880",
      fund_name: "红利低波稳健精选",
      fund_type: "equity",
      themes: ["红利", "央国企", "低波动"],
      current_nav: 1.126,
      daily_return: 0.0015,
      nav_history: [0.94, 0.96, 0.98, 1.01, 1.03, 1.06, 1.08, 1.11, 1.13, 1.15, 1.14, 1.135, 1.13, 1.124, 1.126],
      stage_returns: { "1w": -0.004, "1m": -0.018, "3m": 0.026, "1y": 0.168 },
      portfolio_holdings: ["能源运营商", "公用事业", "高股息银行"],
      policy_signals: ["中特估", "长期资金入市", "分红约束强化"],
      news_summaries: ["高股息资产拥挤度抬升", "部分红利龙头估值处于历史高位附近"],
      social_sentiment_score: 0.62,
      data_quality_score: 0.86,
      data_quality_level: "high",
      quality_warnings: ["短期交易拥挤度偏高"]
    },
    "005827": {
      fund_code: "005827",
      fund_name: "医药创新成长混合",
      fund_type: "mixed",
      themes: ["创新药", "医疗器械", "老龄化"],
      current_nav: 0.964,
      daily_return: 0.006,
      nav_history: [1.34, 1.28, 1.22, 1.17, 1.09, 1.01, 0.95, 0.91, 0.89, 0.9, 0.915, 0.932, 0.948, 0.956, 0.964],
      stage_returns: { "1w": 0.026, "1m": 0.071, "3m": -0.021, "1y": -0.123 },
      portfolio_holdings: ["创新药", "CXO", "医疗器械"],
      policy_signals: ["医保谈判常态化", "创新药出海", "人口老龄化"],
      news_summaries: ["头部创新药海外授权增加", "医疗反腐影响边际减弱"],
      social_sentiment_score: 0.54,
      data_quality_score: 0.84,
      data_quality_level: "high",
      quality_warnings: []
    },
    "009999": {
      fund_code: "009999",
      fund_name: "港股互联网观察组合",
      fund_type: "qdii",
      themes: ["港股互联网", "平台经济", "AI应用"],
      current_nav: 0.671,
      daily_return: 0.012,
      nav_history: [1.18, 1.06, 0.98, 0.91, 0.87, 0.81, 0.74, 0.7, 0.66, 0.64, 0.655, 0.661, 0.666, 0.669, 0.671],
      stage_returns: { "1w": 0.018, "1m": 0.047, "3m": -0.068, "1y": -0.217 },
      portfolio_holdings: ["平台互联网", "在线广告", "云计算"],
      policy_signals: ["平台经济常态化监管", "数字消费", "AI应用落地"],
      news_summaries: ["头部平台回购力度提升", "海外利率变化影响估值弹性"],
      social_sentiment_score: 0.57,
      data_quality_score: 0.76,
      data_quality_level: "medium",
      quality_warnings: ["QDII净值与海外市场存在时间差"]
    },
    "003300": {
      fund_code: "003300",
      fund_name: "军工安全主题混合",
      fund_type: "mixed",
      themes: ["国防军工", "安全", "高端制造"],
      current_nav: 0.918,
      daily_return: -0.0065,
      nav_history: [1.22, 1.18, 1.14, 1.09, 1.03, 0.99, 0.96, 0.94, 0.93, 0.928, 0.925, 0.923, 0.921, 0.919, 0.918],
      stage_returns: { "1w": -0.011, "1m": -0.026, "3m": -0.091, "1y": -0.167 },
      portfolio_holdings: ["航空装备", "卫星通信", "军工电子"],
      policy_signals: ["国家安全", "装备升级"],
      news_summaries: ["订单节奏仍待确认", "行业估值已明显回落"],
      social_sentiment_score: 0.48,
      data_quality_score: 0.74,
      data_quality_level: "medium",
      quality_warnings: ["订单数据透明度偏低"]
    },
    "004444": {
      fund_code: "004444",
      fund_name: "数据不足测试基金",
      fund_type: "mixed",
      themes: ["测试", "数据质量低"],
      current_nav: 1.001,
      daily_return: 0,
      nav_history: [1, 1.01, 1],
      stage_returns: { "1w": 0, "1m": 0, "3m": 0, "1y": 0 },
      portfolio_holdings: [],
      policy_signals: [],
      news_summaries: [],
      social_sentiment_score: 0.3,
      data_quality_score: 0.32,
      data_quality_level: "low",
      quality_warnings: ["净值历史不足", "缺少持仓与报告数据"]
    }
  };

  getFundDataPack(fundCode: string): FundDataPack {
    const raw = structuredClone(this.funds[fundCode] ?? this.funds["007951"]);
    if (raw.fund_code !== fundCode) {
      raw.fund_code = fundCode;
      raw.fund_name = `Mock基金 ${fundCode}`;
      raw.data_quality_score = 0.45;
      raw.data_quality_level = "low";
      raw.quality_warnings = ["未找到基金代码，使用替代 mock 样本"];
    }

    const plan: DataAcquisitionPlan = {
      task_id: "demo-fixture",
      fund_code: raw.fund_code,
      requested_by: "Atlas",
      required_data: ["fund_meta", "current_nav", "nav_history"],
      optional_data: ["holdings", "fund_reports", "policy_evidence", "industry_news", "social_sentiment"],
      provider_candidates: [
        {
          source_id: "demo-fixture",
          source_name: "Demo Fixture Provider",
          source_type: "demo_fixture",
          priority: 999,
          is_demo: true,
          enabled: true
        }
      ],
      acquisition_strategy: "Demo fixture only; not real acquisition.",
      fallback_strategy: "Use only when FUNDSENTINEL_DEMO_MODE=true.",
      created_by: "Argus",
      created_at: this.updatedAt
    };
    const qualityReport: DataQualityReport = {
      data_status: "demo",
      level: raw.data_quality_level,
      score: 35,
      real_source_count: 0,
      demo_source_count: 1,
      successful_source_count: 1,
      failed_source_count: 0,
      missing_core_fields: [],
      missing_auxiliary_fields: [],
      stale_sources: [],
      warnings: ["Demo fixture 数据不能用于真实投资判断。", ...raw.quality_warnings],
      blocking_issues: [],
      allow_downstream_analysis: true,
      allow_strong_conclusion: false,
      generated_by: "Argus",
      generated_at: this.updatedAt
    };
    const gapReport: DataGapReport = {
      fund_code: raw.fund_code,
      missing_data: [],
      failed_sources: [],
      impact: "仅 demo，不允许真实强结论。",
      blocking_downstream_agents: [],
      recommended_solutions: ["接入真实基金净值 provider。", "实现 ManualCsvProvider。"],
      created_by: "Argus",
      created_at: this.updatedAt
    };
    return {
      fund_code: raw.fund_code,
      fund_name: raw.fund_name,
      fund_type: raw.fund_type,
      themes: raw.themes,
      current_nav: raw.current_nav,
      daily_return: raw.daily_return,
      nav_history: raw.nav_history,
      stage_returns: raw.stage_returns,
      portfolio_holdings: raw.portfolio_holdings,
      fund_report_refs: [],
      fund_report_documents: [],
      policy_signals: raw.policy_signals,
      news_summaries: raw.news_summaries,
      social_sentiment_score: raw.social_sentiment_score,
      evidence_items: [],
      data_sources: [
        {
          source_id: "demo-fixture",
          source_name: "Demo Fixture Provider",
          source_type: "demo_fixture",
          trust_level: "DEMO",
          is_demo: true
        }
      ],
      data_acquisition_plan: plan,
      data_quality_report: qualityReport,
      data_gap_report: gapReport,
      acquisition_solutions: [
        {
          problem: "Demo fixture is not real data.",
          severity: "high",
          proposed_actions: ["Do not use demo fixture for real business analysis."],
          engineering_tasks: ["Implement real data providers."],
          manual_workaround: ["Import verified CSV data."],
          owner_agent: "Argus"
        }
      ],
      data_status: "demo",
      allow_downstream_analysis: true,
      allow_strong_conclusion: false,
      data_quality: {
        level: raw.data_quality_level,
        score: 0.35,
        source: "DemoFixtureProvider",
        updated_at: this.updatedAt,
        warnings: raw.quality_warnings,
        is_mock: true
      },
      updated_at: this.updatedAt,
      generated_at: this.updatedAt,
      is_mock: true
    };
  }

  getFundUniverse(): FundDataPack[] {
    return Object.keys(this.funds)
      .filter((code) => code !== "004444")
      .map((code) => this.getFundDataPack(code));
  }

  getPortfolioSnapshot(userId = "mock-user"): PortfolioSnapshot {
    const holdings = [
      {
        fund_code: "007951",
        fund_name: "中证科技先锋混合",
        holding_amount: 36800,
        cost_nav: 1.31,
        current_nav: 1.284,
        daily_pnl: 312.8,
        unrealized_pnl_ratio: -0.0198,
        weight: 0.31,
        is_mock: true
      },
      {
        fund_code: "161725",
        fund_name: "白酒消费精选指数",
        holding_amount: 22600,
        cost_nav: 0.91,
        current_nav: 0.842,
        daily_pnl: -90.4,
        unrealized_pnl_ratio: -0.0747,
        weight: 0.19,
        is_mock: true
      },
      {
        fund_code: "018880",
        fund_name: "红利低波稳健精选",
        holding_amount: 29500,
        cost_nav: 1.02,
        current_nav: 1.126,
        daily_pnl: 44.3,
        unrealized_pnl_ratio: 0.1039,
        weight: 0.25,
        is_mock: true
      },
      {
        fund_code: "005827",
        fund_name: "医药创新成长混合",
        holding_amount: 17800,
        cost_nav: 1.03,
        current_nav: 0.964,
        daily_pnl: 106.8,
        unrealized_pnl_ratio: -0.0641,
        weight: 0.15,
        is_mock: true
      }
    ];
    const totalAssets = 118700;
    const dailyPnl = Number(holdings.reduce((sum, item) => sum + item.daily_pnl, 0).toFixed(2));
    return {
      user_id: userId,
      total_assets: totalAssets,
      daily_pnl: dailyPnl,
      daily_pnl_ratio: Number((dailyPnl / totalAssets).toFixed(5)),
      holdings,
      data_quality: {
        level: "high",
        score: 0.86,
        source: "MockDataService",
        updated_at: this.updatedAt,
        warnings: ["资产与持仓为 mock 数据，不代表真实账户"],
        is_mock: true
      },
      generated_at: this.updatedAt,
      is_mock: true
    };
  }
}
