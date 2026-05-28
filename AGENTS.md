# FundSentinel AI Agent Guidance

1. Do not damage or rewrite existing frontend files, including Stitch-generated UI assets.
2. Do not treat Atlas frontend chat as the current core product.
3. The backend priority order is home intelligence, opportunity square, then fund analysis detail APIs.
4. Every Agent must keep the `AgentResult` contract stable.
5. Backend changes must run the TypeScript test suite before delivery: `cd backend && npm test`.
6. Investment conclusions must be traceable, degradable, and reviewable.
7. Mock data must be explicitly marked with `is_mock=true`.
8. Do not implement real trading, brokerage, bank, Alipay, or account-connection features in this phase.
9. Do not hardcode API keys or secrets. Agents can use the shared AI gateway via environment configuration only.
10. Do not claim guaranteed returns, "must buy", or "risk-free" outcomes.
11. V0.1 backend uses TypeScript + Fastify. Keep frontend and backend decoupled.
12. Atlas is a backend orchestrator for home intelligence and opportunity square, not the main user-facing chat UI.
13. Argus must prioritize real data acquisition over demo or fixture data.
14. Argus must not fabricate fund data, source metadata, freshness, or provider success.
15. Argus must not use demo data as real business data; demo requires explicit `FUNDSENTINEL_DEMO_MODE=true`.
16. Argus must not give investment advice, action, buy, sell, or position conclusions.
17. Argus must block strong conclusions when core data is missing or stale.
18. Provider failures must be recorded and surfaced in DataGapReport.
19. When data cannot be acquired, Argus must output DataAcquisitionSolution with engineering tasks and manual workaround options.
20. Test fixtures are for tests/local demo only and must not become default business output.
21. Argus should actively use legal, public internet providers before falling back to manual import.
22. CSV/manual import is a fallback or bootstrap path, not the default data acquisition strategy.
23. Public web providers must include timeout, source URL, freshness checks, failure reporting, and parser tests.
24. The data-source catalog is a living internet source universe; distinguish `implemented`, `planned`, `requires_license`, `manual`, and `blocked` sources clearly.
25. Do not claim a data source is integrated until a provider fetches it, records provenance, and has tests.
26. Public aggregator sources can bootstrap data, but official disclosure/policy sources must remain higher trust for strong conclusions.
27. Official report-prompt notices are useful provenance, but they must not be treated as full report bodies.
28. `official_fund_reports` should require official disclosure documents, not merely aggregator indexes or generic company notices.
29. New public-web providers must classify document kind conservatively, especially `periodic_report`, `report_notice`, `business_notice`, and `sales_document`.
30. Argus's source universe should be broad, but each provider must be truthful about legal access, implementation status, quality tier, freshness, and coverage gaps.
31. Official disclosure providers that are blocked by site protection must surface that failure in `DataGapReport`; do not bypass site protections or mark blocked sources as successful.
32. Use `/api/data-sources/coverage` to expose which data requirements are covered, partial, licensed-only, or missing.
33. Public provider calls should go through `SourceRegistry` reliability controls so cache, retry, latency, attempt count, and provider health metadata stay consistent.
34. Repeated provider failures should trigger SourceRegistry cooldown/circuit-breaker behavior rather than hammering blocked public sources on every API request.
35. Manual CSV data may be used only as explicit verified fallback via `FUNDSENTINEL_MANUAL_CSV_DIR`; it must keep `source_type=manual_import`, file provenance, and audit warnings.
36. Manual CSV outputs must include checksum, file size, file mtime, row count, date range, latest date, and import timestamp in Argus audit metadata.
37. Argus may maintain a broad internet source universe, including overseas official macro/disclosure sources, but planned or licensed sources must stay labeled until a real provider and tests exist.
38. Macro providers such as World Bank/FRED/IMF/OECD/Eurostat may support Logos context, but they must not be treated as fund NAV, holdings, trading, or position evidence.
39. Official macro/statistics providers that are blocked by site protection must surface that failure in DataGapReport; do not bypass protections or mark blocked official sources as successful.
40. Core NAV data should prefer multiple independent real providers when available; aggregator NAV sources are useful for cross-checking but still need official fund-company or authorized data confirmation before strong conclusions.
41. Same-date NAV conflicts across real providers must be recorded in `nav_consistency_report` and must block strong conclusions until resolved.
42. Argus must keep `source_composition` current; aggregator and manual sources must not be counted as official core coverage.
43. Official disclosure providers must use precise fund identifiers where possible; broad keyword searches must not be used when they can mis-match another fund.
44. Official fund-company pages may be parsed for SSR-embedded NAV rows, but signed/encrypted business APIs must not be bypassed; if signature requirements block direct API use, record the limitation as a provider gap.
