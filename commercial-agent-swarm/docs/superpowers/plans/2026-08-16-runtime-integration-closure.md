# Runtime Integration Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Usage Export, multichannel approvals, feature factories, and CRM sync deployable through closed, fail-safe runtime wiring.

**Architecture:** Keep external services behind injected ports. Authenticate authority at the route boundary, persist decisions through capability functions, and make process entrypoints construct only the components enabled by closed configuration.

**Tech Stack:** Node.js 22, TypeScript 5.7, node:test/tsx, PostgreSQL 17, native fetch/HTTP.

## Global Constraints

- No real network, API, VPS, mail, Telegram, or secret access in tests.
- OpenCode inference remains `https://opencode.ai/zen/go/v1`, `deepseek-v4-flash`, 4096 output tokens and six calls.
- `cost_micro_cents` is usage-value quota, not billed cash cost.
- External integrations and A3 remain disabled by default and fail closed.

---

### Task 1: Official Usage Export contract

**Files:**
- Modify: `runtime/test/opencode-usage-api.test.ts`
- Modify: `runtime/src/opencode-usage-api.ts`

**Interfaces:**
- Produces: `OpenCodeUsageExportClient.export({scope,range,serviceAccountId})` and `OpenCodeUsageProbe.measure({serviceAccountId,...})`.

- [ ] Replace fixtures with a literal 19-column documented CSV and assert the exact range/service-account request.
- [ ] Run the focused test and observe the old timestamp/scopeId contract fail.
- [ ] Implement the exact query, closed reasoning fields, dedicated-account and UTC-window validation.
- [ ] Run focused tests, typecheck, and build.
- [ ] Commit only Usage Export files.

### Task 2: Authenticated approval coordinator wiring

**Files:**
- Modify: `runtime/test/application.test.ts`
- Modify: `runtime/test/simulation-entrypoint.test.ts`
- Modify: `runtime/src/application.ts`
- Modify: `runtime/src/approval-mode.ts`
- Modify: `runtime/src/simulation-entrypoint.ts`
- Modify: `runtime/src/broker-main.ts`
- Modify: `runtime/src/production.ts`

**Interfaces:**
- Consumes: `ApprovalModeCoordinator.submit(evidence, expiresAt)`.
- Produces: separate Sales and Telegram decision routes/tokens with channel derived from authentication.

- [ ] Add failing route tests proving body channel spoofing cannot change authority and dual mode waits for both channels.
- [ ] Add failing configuration tests for distinct file-backed channel secrets and default `either`.
- [ ] Route fixed-channel evidence through the durable store and coordinator; retain the existing one-time grant broker.
- [ ] Wire the coordinator and its dedicated database capability in the entrypoint; exclude recovery.
- [ ] Run focused tests and commit the approval wiring.

### Task 3: Disabled-default external factories

**Files:**
- Create: `runtime/src/integration-factories.ts`
- Create: `runtime/test/integration-factories.test.ts`
- Modify: `runtime/src/broker-main.ts`

**Interfaces:**
- Produces: factories for mail/Telegram and Usage Export that require explicit enablement and injected ports.

- [ ] Add failing tests proving disabled factories do not read token files or invoke ports.
- [ ] Implement closed flags and injected factory dependencies.
- [ ] Make the broker entrypoint use the factories in simulation-disabled mode.
- [ ] Run focused tests and commit factory wiring.

### Task 4: Twenty HTTP client and CRM process

**Files:**
- Create: `runtime/src/twenty-http-client.ts`
- Create: `runtime/src/crm-sync-main.ts`
- Create: `runtime/test/twenty-http-client.test.ts`
- Create: `runtime/test/crm-sync-main.test.ts`
- Modify: `runtime/package.json`
- Modify: `runtime/tsconfig.build.json`

**Interfaces:**
- Consumes: `TwentyClientPort`, `CrmSyncStorePort`, and `TwentyClientConfig`.
- Produces: `startCrmSyncProcess(environment, dependencies)` with `close()`, health/readiness, 60-second polling, and deterministic reconciliation.

- [ ] Add failing fake-HTTP tests for exact origin/method/path, timeout, cap, and closed schemas.
- [ ] Implement the minimum HTTPS client that passes them.
- [ ] Add failing process tests for zero token/network in simulation, inbound-only shadow, active outbox, shutdown, and readiness.
- [ ] Implement entrypoint loop, bounded backoff, health server, and reconciliation command without auto-merge.
- [ ] Run focused tests and commit the CRM process.

### Task 5: Final gates

**Files:**
- Verify all changed runtime and migration files.

- [ ] Run `npm run test:unit`.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-postgres-17.ps1`.
- [ ] Run `git diff --check` and confirm a clean worktree after commits.
- [ ] Report exact commit hashes, commands, pass counts, and remaining deployment risks.
