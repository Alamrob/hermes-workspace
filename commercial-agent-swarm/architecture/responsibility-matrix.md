# Responsibility Matrix

Legend: A = accountable, R = responsible, C = consulted/gate, I = informed, H = human-only decision.

| Process                          | User | Codex Auditor | Orchestrator | Specialist | QA/Compliance    | RevOps/Analytics | Human seller/operator     |
| -------------------------------- | ---- | ------------- | ------------ | ---------- | ---------------- | ---------------- | ------------------------- |
| Project, offer and ICP priority  | A    | R             | I            | I          | C                | C                | C                         |
| Work-order creation              | A    | R             | I            | I          | I                | I                | I                         |
| Mission validation/decomposition | I    | C             | A/R          | C          | C                | I                | I                         |
| Market/account research          | I    | A             | C            | R          | C                | I                | I                         |
| Contact verification             | I    | A             | C            | R          | C                | I                | I                         |
| Scoring and qualification        | I    | A             | C            | R          | C                | C                | I                         |
| Outreach draft                   | I    | A             | C            | R          | C                | I                | C                         |
| External outreach send           | A    | C             | R            | R          | C/mandatory gate | I                | H approval during rollout |
| Meeting preparation              | I    | A             | C            | R          | C                | I                | C                         |
| Discovery/demo/negotiation       | A    | C             | I            | C          | C                | I                | R/H                       |
| Proposal draft                   | I    | A             | C            | R          | C/mandatory gate | C                | C                         |
| Price/scope/discount approval    | A    | C             | I            | I          | C                | I                | H                         |
| CRM authoritative write          | I    | A             | R            | C          | C                | R                | C                         |
| Forecast/analytics               | I    | A             | C            | I          | C                | R                | C                         |
| Onboarding/CS preparation        | I    | A             | C            | R          | C                | C                | R                         |
| Lifecycle external message       | A    | C             | R            | R          | C/mandatory gate | I                | H approval during rollout |
| Contract/payment/legal           | A    | I             | I            | I          | C                | I                | H/R                       |
| Kill switch activation           | A    | R             | R            | R          | R                | I                | R                         |
| Incident recovery/rollback       | A    | C             | C            | I          | C                | I                | R with Runtime Observer   |
