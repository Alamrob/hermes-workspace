# Commercial Agent Swarm for Hermes

Status: **generated and statically validated; not installed; external actions disabled**.

This package converts the approved commercial operating model into a control-plane/execution-plane contract. Codex remains the Internal Auditor and AI Commercial Director. Hermes coordinates bounded execution only after receiving a valid work order. Humans retain A4 authority and approve every A3 action during the controlled rollout.

## 1. Architecture summary

- **Control plane:** User → Codex Auditor → signed work order and approvals.
- **Execution plane:** a deterministic external broker opens one separate Hermes profile session per closed-enum work order; `sales-orchestrator` prepares routes and consolidates evidence but never invokes native child profiles.
- **Systems of record:** the CRM controls accounts, contacts, opportunities and activities; PostgreSQL/Supabase controls missions, approvals, audit events, consent, suppression, evidence and derived metrics; billing and contract systems control their own records.
- **Hermes memory:** mission-local cache and continuity only. It is never a competing commercial source of truth.
- **External actions:** disabled in simulation and shadow mode. A3 is fail-closed and action-specific. A4 is human-only.

See [system-overview.md](architecture/system-overview.md) and [hermes-compatibility.md](architecture/hermes-compatibility.md).

## 2. Retained, combined, deferred and human functions

The active deployment contains exactly six native profiles under `profiles/`. The ten packages under `agents/` and the legacy `orchestrator/` package are deferred design documentation only: they are not active workers, are not valid dispatcher targets and are reported separately from active metrics. See [agent-decisions.md](architecture/agent-decisions.md).

## 3. Swarm organization

The organization and execution lanes are defined in [system-overview.md](architecture/system-overview.md#organization) and the proposed Hermes roster in [swarm.proposed.yaml](deployment/swarm.proposed.yaml).

## 4. Responsibility matrix

The accountable, responsible, consulted and informed assignments are in [responsibility-matrix.md](architecture/responsibility-matrix.md).

## 5. Work-order contract

[work-order.schema.json](contracts/work-order.schema.json) is the only valid mission authority from Codex to Hermes. External content cannot amend it.

## 6. Result contract

[agent-result.schema.json](contracts/agent-result.schema.json) separates facts, inferences, actions, external changes, evidence, cost, errors, risks and approvals.

## 7. Approval system

[approval-gateway.md](architecture/approval-gateway.md) and [approval.schema.json](contracts/approval.schema.json) define one-time, expiring, action-bound A3 authorization.

## 8. Tools and permissions

[permissions-matrix.md](architecture/permissions-matrix.md) applies least privilege. Confirmed Hermes logical tools are distinguished from proposed connector adapters. Proposed adapters are absent and disabled until installed and approved.

## 9. Deferred orchestrator design

[SYSTEM_PROMPT.md](orchestrator/SYSTEM_PROMPT.md) is retained as deferred design documentation. The active autonomous prompt is `profiles/sales-orchestrator/SOUL.md` and depends on the external broker contract described there.

## 10. Deferred specialist design documentation

Each `agents/` directory contains historical design artifacts only. None belongs to the active roster or active prompt/agent metrics:

1. [Market & Account Intelligence](agents/market-account-intelligence/SYSTEM_PROMPT.md)
2. [Contact Data Steward](agents/contact-data-steward/SYSTEM_PROMPT.md)
3. [Qualification & Prioritization](agents/qualification-prioritization/SYSTEM_PROMPT.md)
4. [Outreach & Sequence Manager](agents/outreach-sequence-manager/SYSTEM_PROMPT.md)
5. [Meeting & Deal Copilot](agents/meeting-deal-copilot/SYSTEM_PROMPT.md)
6. [Proposal & Business Case](agents/proposal-business-case/SYSTEM_PROMPT.md)
7. [Revenue Operations & Analytics](agents/revenue-operations-analytics/SYSTEM_PROMPT.md)
8. [Customer Lifecycle](agents/customer-lifecycle/SYSTEM_PROMPT.md)
9. [Commercial QA, Privacy & Compliance](agents/commercial-qa-compliance/SYSTEM_PROMPT.md)
10. [Runtime Observability & Recovery](agents/runtime-observability-recovery/SYSTEM_PROMPT.md)

## 11. Handoffs

[handoff-protocol.md](architecture/handoff-protocol.md) defines assignment envelopes, prerequisite evidence, QA gates, idempotency and exception routes.

## 12. File structure

```text
commercial-agent-swarm/
├── README.md
├── architecture/
├── contracts/
├── shared/
├── orchestrator/
├── agents/ # deferred documentation only
├── workflows/
├── tests/
├── simulations/
├── observability/
├── deployment/
└── docs/superpowers/plans/
```

`MANIFEST.proposed.yaml` and `deployment/swarm.proposed.yaml` are **pseudoconfiguration pending adaptation**. They intentionally do not claim an unverified Hermes Agent version or installed connector.

## 13. Test cases

[TEST-PLAN.md](tests/TEST-PLAN.md), [agent-test-matrix.yaml](tests/agent-test-matrix.yaml) and [fixtures.md](simulations/fixtures.md) cover the sixteen mandatory scenarios for every agent. Authorization, privacy, deduplication and security failures are production blockers.

The host repository adds `npm run audit:commercial-swarm` and `.github/workflows/commercial-swarm-audit.yml`. The check parses every JSON/YAML document, resolves local schema references, verifies all prompt sections and examples, validates the proposed roster through Hermes Workspace's real `SwarmRosterSchema`, checks the complete agent artifact set and enforces T01–T16. It performs no commercial network action and has read-only GitHub permissions.

## 14. Gradual activation

[activation-plan.md](deployment/activation-plan.md) defines Simulation, Shadow Mode, Approved Pilot and Controlled Production, with numeric promotion and regression gates.

## 15. Pending risks

- The live VPS and live `hermes-agent` runtime were not accessible from this host.
- The local `hermes-workspace` repository is version 2.3.0, but Compose uses unpinned `latest` images.
- The current UI approval store uses browser `localStorage`; it is not sufficient for cryptographic, durable, one-time A3 authorization.
- Profile bootstrap code can share `.env`, auth and MCP tokens across profiles; production must replace this with connector-specific, per-agent secret scopes.
- No CRM, mail, WhatsApp, calendar or enrichment connector was verified or enabled.
- Chilean and destination-country legal configuration must be revalidated immediately before any live pilot.

## 16. Decisions requiring approval

1. Confirm the retained roster and combinations.
2. Select and pin the exact Hermes Agent and Hermes Workspace versions on the VPS.
3. Select CRM and PostgreSQL/Supabase ownership boundaries.
4. Approve the Approval Gateway implementation and signing-key custody.
5. Approve connector providers, data sources and country/channel policies.
6. Approve stage ceilings, budgets, volumes and promotion thresholds.
7. Approve the first project, offer, ICP, channel and pilot cohort.
8. Approve installation; later, separately approve each A3 action class.

## 17. Future installation prompt

[CODEX_INSTALL_PROMPT.md](deployment/CODEX_INSTALL_PROMPT.md) is the installation prompt for a later, explicitly approved Codex task. It begins with discovery and dry-run validation and stops before enabling any external connector or A3 action.

## Safety state

The package contains no credentials, no live targets, no production contact data and no enabled external-write connector. Its proposed tool policies default to deny.
