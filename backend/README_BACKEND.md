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
- `DataQualityReport`: data status, source counts, missing fields, stale sources, provider failures, and downstream permissions.
- `DataGapReport`: what is missing, which providers failed, which downstream Agents are blocked, and what solutions are recommended.
- `DataAcquisitionSolution`: proposed engineering and manual workaround tasks.

Argus deliberately separates `missing_core_fields` from `missing_auxiliary_fields`. Core fields decide whether the DAG may continue at all. Auxiliary fields decide whether Logos/Atlas must downgrade and whether strong conclusions are forbidden.

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

## Data Sources

Data providers live under `src/dataSources/`:

- `EastMoneyFundProvider`: implemented real public-web provider for fund meta, current NAV, NAV history, stage returns, and limited position-code hints from EastMoney/Tiantian Fund page JavaScript.
- `EastMoneyFundArchiveProvider`: implemented real public-web provider for public stock/bond holding tables and disclosed holding dates from Tiantian Fund archive pages.
- `EastMoneyFundAnnouncementProvider`: implemented real public-web provider for periodic fund report announcement indexes, detail URLs, PDF attachment URLs, and HEAD-based PDF availability metadata. This is a report discovery/source-reference provider, not a replacement for official report PDF parsing.
- `CmfChinaFundOfficialProvider`: implemented first fund-company official-site adapter. It parses CMF China official fund detail pages, product notices, current NAV snippets, and report-prompt notices. It records official provenance, but report-prompt notices are not treated as full report bodies.
- `CsrcFundDisclosureProvider`: implemented first official disclosure probe for the CSRC fund e-disclosure site. It parses official periodic-report links when reachable and records site-protection or endpoint failures as explicit `DataGapReport` evidence.
- `FundCompanyReportProvider`: intended real provider for holdings and official fund reports.
- `CninfoReportProvider`: intended backup official report source.
- `PolicyNewsProvider`: intended provider for policy and industry news evidence.
- `GovCnPolicyProvider`: implemented official Gov.cn latest-policy JSON provider. It uses fund context collected by earlier providers, such as real fund name, themes, and holdings, to map broad official policy background. It must not infer themes from stale mock fund-code mappings.
- `ManualCsvProvider`: fallback real-data workaround for manually imported CSV; not the default path.
- `DemoFixtureProvider`: local demo fixture, enabled only when `FUNDSENTINEL_DEMO_MODE=true`.

Real providers are listed before demo fixtures. Provider failures are recorded and surfaced in gap reports. Demo fixture data is never treated as real business data.

Argus also has a source universe catalog exposed by `GET /api/data-sources/catalog`. The catalog ranks stable, high-quality sources first:

- authoritative disclosure sources such as CSRC fund e-disclosure, CSRC official releases, AMAC, CNInfo, and fund company official sites
- practical NAV/history sources such as EastMoney/Tiantian Fund, with legal/terms review required before automated use
- manual CSV import as a fallback/bootstrap path with audit trail, not the main acquisition route
- licensed commercial APIs such as Wind/Choice/Tushare when credentials and legal rights exist
- policy and official macro/industry sources such as Gov.cn, NDRC, MIIT, PBOC, NBS, MOF, and SAFE for Logos evidence
- index/benchmark sources such as CSI Index for index-fund validation
- financial media as secondary evidence only
- social/forum sentiment as weak optional evidence only
- demo fixture last, only for tests/local demo

The catalog is a living source universe. A source marked `planned` or `requires_license` is not considered integrated until a provider fetches it, records provenance, and has parser tests.

`GET /api/data-sources/coverage` exposes Argus's coverage matrix by requirement. It separates implemented providers from planned or licensed sources, so the backend can answer which high-quality data needs are covered now, which are partial, and which remain gaps. This is the concrete route toward the broad internet-data goal without pretending unimplemented sources are already integrated.

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
- `https://www.cmfchina.com/web/fundDetail/{fund_code}/index.html` for CMF China official fund-company product details and official notice/report-prompt references.
- `http://eid.csrc.gov.cn/fund` for the CSRC fund e-disclosure official entrypoint. The provider records official-site blocking or endpoint failures rather than silently ignoring them.
- `https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json` for official latest national policy metadata. Argus treats this as macro policy context only; it does not make single-fund conclusions from policy titles.

These providers parse public responses without `eval`, record `raw_reference`, apply timeout/freshness checks, and mark results as real provider data (`is_demo=false`). Aggregator sources can support partial analysis, but strong conclusions require official, identifiable report bodies and complete core data. Official report-prompt notices, such as "quarterly report prompt announcement", are recorded as `report_notice`; they do not clear the `official_fund_reports` gap by themselves.

`FundDataPack` now includes both lightweight `fund_report_refs` and structured `fund_report_documents`. Report documents include title, announcement ID, publish date, document kind, detail URL, PDF URL, PDF verification flag, content type, content length, source name, source type, and trust level.

Provider execution is context-aware. `SourceRegistry` passes merged data from earlier successful providers to later providers. Policy matching must use real acquired context, not hardcoded mock-era fund-code assumptions.

`SourceRegistry` also owns provider reliability controls:

- successful non-demo provider results are cached for a short TTL (`FUNDSENTINEL_PROVIDER_CACHE_TTL_MS`, default 5 minutes)
- transient failures such as timeouts, fetch failures, network/socket errors, and 5xx responses are retried (`FUNDSENTINEL_PROVIDER_RETRY_COUNT`, default 1)
- clear non-transient failures, such as official-site blocking/405 responses, are recorded without blind retry loops
- provider outputs include `attempt_count`, `latency_ms`, `cache_hit`, and `cache_expires_at`
- `/api/data-sources/health` includes per-source latency, last attempt count, cache hit count, cache entries, and failure count

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
3. Add official fund report providers for holdings and reports, especially fund company official sites, CSRC disclosure systems, and CNInfo where available.
4. Add policy/news providers with official-source priority and media as secondary evidence only.
5. Implement `ManualCsvProvider` only as verified fallback/bootstrap import.
6. Persist blackboard and provider health snapshots with SQLite or Postgres once real data enters.
7. Add source freshness, trust scoring, and data lineage to every real evidence item.
8. Run the same test suite against provider-backed fixtures before enabling production data.
