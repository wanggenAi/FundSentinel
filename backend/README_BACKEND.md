# FundSentinel AI Backend V0.1

FundSentinel AI is an AI-native fund research and decision-support backend for personal investors. V0.1 uses TypeScript + Fastify because the near-term backend is mostly concurrent IO, Agent orchestration, API serving, and future streaming/task expansion.

The current backend priority is:

1. Home intelligence: assets, holdings, strategy triggers, risk reminders, and today's focus.
2. Opportunity square: candidate funds selected only when Argus has enough real or explicitly demo-mode data.
3. Single-fund analysis: full Agent snapshots for future fund detail pages.

Atlas is not the foreground chat product in this phase. Atlas is the backend chief orchestrator that schedules specialist Agents, reviews conflicts, applies degradation, and emits structured results.

## Architecture

The backend is separated from Stitch-generated frontend assets:

```text
backend/
  src/
    agents/
    api/
    orchestration/
    schemas/
    services/
    storage/
  tests/
  README_BACKEND.md
  package.json
  tsconfig.json
```

V0.1 is now real-data-first at the Argus boundary. Demo/fixture data exists only for tests and explicit local demo mode.

## Agent Responsibilities

- Atlas: Chief Orchestrator Agent. Schedules specialist Agents, resolves conflicts, downgrades unsafe conclusions, and produces final structured decisions.
- Argus: Real Data Steward Agent. Builds acquisition plans, calls data providers, validates source quality, reports data gaps, and blocks downstream strong conclusions when real data is missing.
- Logos: Industry Logic Analyst Agent. Evaluates hard logic from policy, themes, holdings, reports/news, and treats social sentiment as weak evidence.
- Nadir: Valuation Position Agent. Computes historical percentile, distance from high/low, drawdown, and low-position score.
- Vega: Turning Point Signal Agent. Detects falling, stabilizing, improving, or weakening trend states from mock NAV history.
- Aegis: Risk & Position Manager Agent. Converts Agent outputs into conservative actions such as `observe`, `trial_buy`, `staged_buy`, `hold`, `reduce`, `exit`, and `avoid`.

## Unified AI Gateway

Every Agent inherits a shared `askAI()` capability from `BaseAgent`. V0.1 remains deterministic by default, but Agents can call one OpenAI-compatible API when configured:

```bash
export FUNDSENTINEL_AI_ENABLED=true
export OPENAI_API_KEY="..."
export OPENAI_MODEL="..."
# Optional for a compatible gateway:
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

No API key is hardcoded. If the gateway is disabled or missing config, Agents continue using deterministic mock rules.

## Argus Real Data Steward

Argus is a data-source employee, not a mock-data generator. Its job is to acquire and validate real fund data before any investment reasoning happens.

Argus now produces:

- `DataAcquisitionPlan`: what data Atlas requested, what is required, which providers are candidates, and what fallback path should be used.
- `FundDataPack`: the normalized fund data package, only complete when data is ready or partial.
- `DataQualityReport`: data status, source counts, source composition, missing fields, stale sources, provider failures, and downstream permissions.
- `DataGapReport`: what is missing, which providers failed, structured failure details for each failed provider, which downstream Agents are blocked, and what solutions are recommended.
- `DataAcquisitionSolution`: proposed engineering and manual workaround tasks.

Argus deliberately separates `missing_core_fields` from `missing_auxiliary_fields`. Core fields decide whether the DAG may continue at all. Auxiliary fields decide whether Logos/Atlas must downgrade and whether strong conclusions are forbidden.

Argus also separates source composition into `authoritative`, `aggregator`, `manual`, `macro`, `demo`, and `failed` buckets. Aggregator NAV/history sources can help bootstrap and cross-check data, but they do not count as official core coverage. Manual CSV imports are tracked separately with audit metadata and must not be presented as official automated data.

Strong conclusions also require official core NAV coverage. If `current_nav` and `nav_history` are available only from aggregator or manual sources, Argus keeps the analysis at `partial`, adds `official_current_nav` / `official_nav_history` gaps, and sets `allow_strong_conclusion=false` until an official fund-company, regulatory, or authorized source confirms the core NAV data.

`DataStatus` values:

- `ready`: real data is sufficient for downstream Agent analysis.
- `partial`: real data is partly available; downstream Agents may run but must downgrade.
- `insufficient`: core data is missing; downstream Agents must not output buy/sell/position conclusions.
- `unavailable`: real data is unavailable; the DAG stops after Argus and Atlas returns a data-unavailable result.
- `demo`: explicit demo fixture data only; never a real business conclusion.

Core required data:

- `fund_meta`
- `current_nav`
- `nav_history`

If any core data is missing, Argus returns `insufficient` or `unavailable`. If only demo data is present, `allow_strong_conclusion=false` and confidence is capped.

Argus also produces a structured `nav_consistency_report` inside `DataQualityReport`. When multiple real NAV providers return comparable same-date current NAV values, Argus checks their absolute and relative differences. A material conflict adds `nav_consistency` to auxiliary gaps, sets `allow_strong_conclusion=false`, and forces downstream Agents to treat the fund analysis as degraded until the discrepancy is resolved or confirmed by an official/authorized source.

## Data Sources

Data providers live under `src/dataSources/`:

- `EastMoneyFundProvider`: implemented real public-web provider for fund meta, current NAV, NAV history, stage returns, and limited position-code hints from EastMoney/Tiantian Fund page JavaScript.
- `EastMoneyNavHistoryProvider`: implemented second real public-web NAV provider using the EastMoney/Tiantian F10 historical NAV endpoint. It supplies dated NAV rows for cross-checking core NAV freshness and history.
- `EastMoneyFundArchiveProvider`: implemented real public-web provider for public stock/bond holding tables and disclosed holding dates from Tiantian Fund archive pages.
- `EastMoneyFundAnnouncementProvider`: implemented real public-web provider for periodic fund report announcement indexes, detail URLs, PDF attachment URLs, and HEAD-based PDF availability metadata. This is a report discovery/source-reference provider, not a replacement for official report PDF parsing.
- `CmfChinaFundOfficialProvider`: implemented first fund-company official-site adapter. It parses CMF China official fund detail pages, product notices, current NAV snippets, SSR-embedded recent NAV history, and report-prompt notices. It records official provenance, but report-prompt notices are not treated as full report bodies.
- `HuaAnFundOfficialProvider`: implemented second fund-company official-site adapter. It parses HuaAn official fund detail pages, the official NAV table endpoint, top holding names, and disclosure links. It contributes to `official_current_nav` / `official_nav_history` coverage for HuaAn funds, while still requiring CSRC/company PDF parsing for full report-body evidence.
- `CsrcFundDisclosureProvider`: implemented first official disclosure probe for the CSRC fund e-disclosure site. It parses official periodic-report links when reachable and records site-protection or endpoint failures as explicit `DataGapReport` evidence.
- `CninfoReportProvider`: implemented official CNInfo/巨潮 fund disclosure adapter for listed funds covered by `fund_stock.json`, such as ETF/LOF/closed-end funds. It performs precise fund code + orgId matching, queries `hisAnnouncement/query`, records official PDF metadata, and avoids broad keyword searches that could mis-match another fund.
- `FundCompanyReportProvider`: intended real provider for holdings and official fund reports.
- `GovCnPolicyProvider`: implemented official Gov.cn latest-policy JSON provider. It uses fund context collected by earlier providers, such as real fund name, themes, and holdings, to map broad official policy background. It must not infer themes from stale mock fund-code mappings.
- `PolicyNewsProvider`: implemented official policy/industry news provider for the National Development and Reform Commission news-release list. It maps real acquired fund context to official industry-policy releases as supporting Logos evidence only.
- `StatsGovMacroProvider`: implemented official National Bureau of Statistics endpoint probe/parser for China macro and industry indicators. If the official site blocks automated access, Argus surfaces the failure as a data gap and does not bypass site protection.
- `FredMacroProvider`: implemented official FRED Federal Reserve Economic Data provider for US rates, Treasury yields, CPI, and unemployment context. It requires `FRED_API_KEY` or `FUNDSENTINEL_FRED_API_KEY`; if the key is missing, Argus records an explicit provider failure and does not fabricate macro data.
- `WorldBankMacroProvider`: implemented official World Bank Open Data API provider for low-frequency macro context such as GDP growth, CPI inflation, and real interest rates. It writes structured `macro_indicators` and must not be treated as fund NAV, holdings, or trading evidence.
- `ImfDataMapperProvider`: implemented official IMF DataMapper API provider for selected WEO macro series such as real GDP growth, inflation, and unemployment. It filters requested country/region codes explicitly and provides global/QDII context only.
- `EurostatProvider`: implemented official Eurostat Statistics API provider for selected stable annual EU/euro-area macro series such as real GDP growth and unemployment. It parses JSON-stat 2.0 responses and keeps changed/discontinued HICP mappings out until they are explicitly verified.
- `ManualCsvProvider`: implemented fallback real-data workaround for manually imported CSV. It is enabled only when `FUNDSENTINEL_MANUAL_CSV_DIR` points to an operator/user verified directory, reads `{fund_code}.csv`, requires `fund_code,date,nav`, and records file checksum, size, mtime, row count, date range, latest date, and import timestamp.
- `DemoFixtureProvider`: local demo fixture, enabled only when `FUNDSENTINEL_DEMO_MODE=true`.

Real providers are listed before demo fixtures. Provider failures are recorded and surfaced in gap reports. Demo fixture data is never treated as real business data.

Argus also has a source universe catalog exposed by `GET /api/data-sources/catalog`. The catalog ranks stable, high-quality sources first:

- authoritative disclosure sources such as CSRC fund e-disclosure, CSRC official releases, AMAC, CNInfo, and fund company official sites
- practical NAV/history sources such as EastMoney/Tiantian Fund, with legal/terms review required before automated use
- manual CSV import as a fallback/bootstrap path with audit trail, not the main acquisition route
- licensed commercial APIs such as Wind/Choice/Tushare when credentials and legal rights exist
- policy and official macro/industry sources such as Gov.cn, NDRC, MIIT, NBS, PBOC, MOF, and SAFE for Logos evidence
- index/benchmark sources such as CSI Index for index-fund validation
- global official disclosure and macro sources such as SEC EDGAR, HKEX disclosure pages, World Bank, FRED, IMF, OECD, and Eurostat for QDII/global fund context
- licensed global market data APIs such as Nasdaq Data Link when credentials and legal rights exist
- financial media as secondary evidence only
- social/forum sentiment as weak optional evidence only
- demo fixture last, only for tests/local demo

The catalog is a living source universe. A source marked `planned` or `requires_license` is not considered integrated until a provider fetches it, records provenance, and has parser tests.

`GET /api/data-sources/coverage` exposes Argus's coverage matrix by requirement. It separates implemented providers from planned or licensed sources, so the backend can answer which high-quality data needs are covered now, which are partial, and which remain gaps. This is the concrete route toward the broad internet-data goal without pretending unimplemented sources are already integrated.

The coverage matrix includes `official_current_nav` and `official_nav_history` as separate strong-conclusion gates. `current_nav` or `nav_history` may be partially covered by aggregator sources, while the official gates only count authoritative fund-company, regulatory, or authorized sources.

## Shared Blackboard

`SharedBlackboard` stores the complete state of one analysis task:

- task creation
- Argus data pack
- Agent results
- dependency checks
- degradation or failure marks
- full snapshot export

This makes each analysis traceable and replay-friendly.

## DAG Flow

Single-fund analysis runs in this order:

```text
Argus
  -> Logos
  -> Nadir
  -> Vega

Logos + Nadir + Vega
  -> Aegis

Argus + Logos + Nadir + Vega + Aegis
  -> Atlas final review
```

`Logos`, `Nadir`, and `Vega` run concurrently with `Promise.all` after Argus completes.

If Argus returns `insufficient` or `unavailable`, the DAG stops after Argus. Atlas returns a data-unavailable result and no Logos/Nadir/Vega/Aegis strategy conclusion is produced.

## APIs

- `GET /health`
- `GET /api/agents`
- `GET /api/data-sources`
- `GET /api/data-sources/catalog`
- `GET /api/data-sources/coverage`
- `GET /api/data-sources/health`
- `GET /api/data-sources/gaps/{fund_code}`
- `POST /api/data-sources/manual-import/plan`
- `GET /api/home`
- `GET /api/opportunities?limit=6`
- `GET /api/funds/{fund_code}/analysis`
- `POST /api/analyze`

Example `POST /api/analyze` body:

```json
{
  "fund_code": "007951",
  "user_request": "分析这个基金现在是否适合进入观察或试探买入"
}
```

V0.1 deliberately does not implement an Atlas chat endpoint.

## Live Provider Behavior

In normal dev/runtime mode, Argus actively tries enabled public internet providers. `EastMoneyFundProvider` currently fetches:

```text
https://fund.eastmoney.com/pingzhongdata/{fund_code}.js
```

The live public provider set currently includes:

- `https://fund.eastmoney.com/pingzhongdata/{fund_code}.js` for fund meta, current NAV, historical NAV, stage returns, and position-code hints.
- `https://fundf10.eastmoney.com/FundArchivesDatas.aspx` for disclosed stock/bond holding archive tables.
- `https://api.fund.eastmoney.com/f10/JJGG` for periodic fund report announcement indexes, with the F10 referer required by the public endpoint.
- `https://pdf.dfcfw.com/pdf/H2_{announcement_id}_1.pdf` for report PDF attachment availability checks. Argus currently records whether the latest report PDFs respond as `application/pdf` and stores content length when available.
- `https://www.cmfchina.com/web/fundDetail/{fund_code}/index.html` for CMF China official fund-company product details, SSR-embedded recent NAV rows, and official notice/report-prompt references.
- `https://www.huaan.com.cn/funds/{fund_code}/index.shtml` plus `https://www.huaan.com.cn/funddetail/selectFundayByCode.do?fd.fundcode={fund_code}` for HuaAn official fund details, recent NAV table rows, holdings names, and disclosure links.
- `http://eid.csrc.gov.cn/fund` for the CSRC fund e-disclosure official entrypoint. The provider records official-site blocking or endpoint failures rather than silently ignoring them.
- `https://www.cninfo.com.cn/new/data/fund_stock.json` plus `https://www.cninfo.com.cn/new/hisAnnouncement/query` for CNInfo official listed-fund disclosure lookup and PDF metadata.
- `https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json` for official latest national policy metadata. Argus treats this as macro policy context only; it does not make single-fund conclusions from policy titles.
- `https://www.ndrc.gov.cn/xwdt/xwfb/` for official National Development and Reform Commission policy/industry news releases. Argus treats this as supporting industry-policy context only.
- `https://api.stlouisfed.org/fred/series/observations` for official FRED macro series when `FRED_API_KEY` or `FUNDSENTINEL_FRED_API_KEY` is configured. The provider sanitizes returned source URLs and never returns the API key.
- `https://www.imf.org/external/datamapper/api/v2` for official IMF DataMapper/WEO macro series. Argus filters the returned country/region codes to the configured request set and treats this as macro context only.
- `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data` for selected official Eurostat JSON-stat macro series. Argus currently uses stable annual GDP and unemployment datasets; HICP inflation remains a planned mapping extension.

Optional official macro API configuration:

```bash
export FRED_API_KEY="..."
# or
export FUNDSENTINEL_FRED_API_KEY="..."
```

These providers parse public responses without `eval`, record `raw_reference`, apply timeout/freshness checks, and mark results as real provider data (`is_demo=false`). Aggregator sources can support partial analysis, but strong conclusions require official, identifiable report bodies and complete core data. Official report-prompt notices, such as "quarterly report prompt announcement", are recorded as `report_notice`; they do not clear the `official_fund_reports` gap by themselves.

`FundDataPack` now includes both lightweight `fund_report_refs` and structured `fund_report_documents`. Report documents include title, announcement ID, publish date, document kind, detail URL, PDF URL, PDF verification flag, content type, content length, source name, source type, and trust level.

Provider execution is context-aware. `SourceRegistry` passes merged data from earlier successful providers to later providers. Policy matching must use real acquired context, not hardcoded mock-era fund-code assumptions.

`SourceRegistry` also owns provider reliability controls:

- successful non-demo provider results are cached for a short TTL (`FUNDSENTINEL_PROVIDER_CACHE_TTL_MS`, default 5 minutes)
- transient failures such as timeouts, fetch failures, network/socket errors, and 5xx responses are retried (`FUNDSENTINEL_PROVIDER_RETRY_COUNT`, default 1)
- clear non-transient failures, such as official-site blocking/405 responses, are recorded without blind retry loops
- default runtime registries share an in-memory provider cache and health state across API requests; injected test providers stay isolated unless `shareState=true`
- repeated provider failures open a short circuit breaker (`FUNDSENTINEL_PROVIDER_FAILURE_THRESHOLD`, default 2; `FUNDSENTINEL_PROVIDER_FAILURE_COOLDOWN_MS`, default 2 minutes) so blocked or broken sources are not hammered every request
- provider outputs include `attempt_count`, `latency_ms`, `cache_hit`, `cache_expires_at`, and `skipped_by_circuit_breaker`
- `/api/data-sources/health` includes per-source latency, last attempt count, cache hit count, cache entries, failure count, circuit-open count, and cooldown remaining time

In test mode, live providers are disabled by default via `NODE_ENV=test` so CI does not depend on network availability. Parser/provider behavior is covered with injected fetch fixtures.

## Install

```bash
cd backend
npm install
```

## Run

```bash
cd backend
npm run dev
```

Default URL:

```text
http://127.0.0.1:8000
```

## Test

```bash
cd backend
npm test
```

## Build

```bash
cd backend
npm run build
npm start
```

## Demo Data Policy

Demo/fixture data is not the business default. It is allowed only for tests and explicit local demo mode:

```bash
FUNDSENTINEL_DEMO_MODE=true npm run dev
```

Without demo mode, if real providers cannot supply core data, business APIs return data-unavailable states instead of fake strategy triggers or fake opportunity candidates.

## Manual CSV Fallback

Manual CSV import is now a real fallback provider, but it is not the default acquisition path. Enable it explicitly:

```bash
export FUNDSENTINEL_MANUAL_CSV_DIR="/absolute/path/to/verified-fund-csv"
```

Each file is named `{fund_code}.csv`, for example `007951.csv`. Required columns:

```text
fund_code,date,nav
```

Optional columns:

```text
fund_name,fund_type,daily_return,holding,theme
```

Manual CSV data is marked as `source_type=manual_import`, `is_demo=false`, and includes the file path in `raw_reference`. Argus also exposes `manual_import_audit` in the provider payload and `data_sources` output with:

- `file_sha256`
- `file_size_bytes`
- `file_mtime`
- `row_count`
- `date_start`
- `date_end`
- `latest_date`
- `imported_at`

It must be treated as operator/user verified data with audit requirements, not as automatic internet acquisition.

## Reliability Rules

- Investment conclusions must include risk warnings or invalidation conditions.
- The backend does not guarantee returns.
- The backend does not execute trades.
- Low data quality forces strategy degradation.
- Critical Agent failure prevents `trial_buy` or `staged_buy`.
- Forum/social sentiment is never core evidence.
- Agent output contracts must remain stable.
- Argus must not fabricate data.
- Argus must not give investment advice.
- Demo/fixture data must not drive real investment conclusions.

## Future Performance Path

TypeScript/Fastify is the V0.1 orchestration and API layer. If later workloads become CPU-heavy, keep the API and Agent contracts stable and move heavy scoring, optimization, or data ingestion workers to Rust or Go behind queues.

## Future Real Data Integration

Recommended next steps:

1. Cross-check EastMoney NAV data against a second real source.
2. Keep `FundDataPack` as the canonical input contract to specialist Agents.
3. Add more official fund-company adapters for holdings, NAV, and reports, especially broadening from CMF China/HuaAn to more top fund companies and cross-checking with CSRC disclosure systems and CNInfo where available.
4. Add policy/news providers with official-source priority and media as secondary evidence only.
5. Implement `ManualCsvProvider` only as verified fallback/bootstrap import.
6. Persist blackboard and provider health snapshots with SQLite or Postgres once real data enters.
7. Add source freshness, trust scoring, and data lineage to every real evidence item.
8. Run the same test suite against provider-backed fixtures before enabling production data.
