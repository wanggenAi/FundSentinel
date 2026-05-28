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
