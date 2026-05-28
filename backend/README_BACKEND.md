# FundSentinel AI Backend V0.1

FundSentinel AI is an AI-native fund research and decision-support backend for personal investors. V0.1 uses TypeScript + Fastify because the near-term backend is mostly concurrent IO, Agent orchestration, API serving, and future streaming/task expansion.

The current backend priority is:

1. Home intelligence: assets, holdings, strategy triggers, risk reminders, and today's focus.
2. Opportunity square: mock candidate funds selected through multi-Agent analysis.
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

All current fund, portfolio, evidence, and analysis data is mock data and is explicitly marked with `is_mock: true`.

## Agent Responsibilities

- Atlas: Chief Orchestrator Agent. Schedules specialist Agents, resolves conflicts, downgrades unsafe conclusions, and produces final structured decisions.
- Argus: Data Steward Agent. Produces mock `FundDataPack` values and data quality metadata.
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

## APIs

- `GET /health`
- `GET /api/agents`
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

## Mock Data Policy

All current data is mock:

- fund universe
- portfolio holdings
- evidence items
- NAV history
- strategy triggers
- opportunity candidates
- final decisions

Responses must never present mock data as real market data.

## Reliability Rules

- Investment conclusions must include risk warnings or invalidation conditions.
- The backend does not guarantee returns.
- The backend does not execute trades.
- Low data quality forces strategy degradation.
- Critical Agent failure prevents `trial_buy` or `staged_buy`.
- Forum/social sentiment is never core evidence.
- Agent output contracts must remain stable.

## Future Performance Path

TypeScript/Fastify is the V0.1 orchestration and API layer. If later workloads become CPU-heavy, keep the API and Agent contracts stable and move heavy scoring, optimization, or data ingestion workers to Rust or Go behind queues.

## Future Real Data Integration

Recommended next steps:

1. Replace `MockDataService` with provider adapters for fund basics, NAV history, portfolio imports, reports, policy, and industry datasets.
2. Keep `FundDataPack` as the canonical input contract to specialist Agents.
3. Persist blackboard snapshots with SQLite or Postgres once real data enters.
4. Add source freshness, trust scoring, and data lineage to every real evidence item.
5. Run the same test suite against provider-backed fixtures before enabling production data.

