# Commercial Database Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining production-principal, capability-membership, catalog-activation and migration-002 rollback findings without changing legacy data.

**Architecture:** Production config resolves three PostgreSQL credentials and validates pairwise-distinct usernames before constructing pools. Migration 002 owns append-only activation events/current views and enumerated grants; its rollback enumerates only 002-owned objects.

**Tech Stack:** TypeScript 5.7, Node 22+, PostgreSQL 17, node:test, pg 8.16.

## Global Constraints

- No external network, VPS, Compose, profile, validator or infrastructure changes.
- Preserve non-empty `public.approvals` and `public.agent_runs` byte-for-byte.
- PostgreSQL functions use `SECURITY DEFINER` with `SET search_path=pg_catalog` and explicit grants.
- Catalog versions and activation history are append-only; no catalog UPDATE implements rotation.
- Default privileges revoke public function execution in `catalog`, `control` and `mail`.

---

### Task 1: Production database principals

**Files:**
- Modify: `commercial-agent-swarm/runtime/src/production.ts`
- Modify: `commercial-agent-swarm/runtime/test/production.test.ts`

**Interfaces:**
- Produces: `parseDatabasePrincipal(connectionString: string): string`
- Produces: `resolveDatabaseConfiguration(environment, readSecretFile): Promise<{runtimeUrl,approverUrl,safetyUrl}>`
- Produces: `verifyProductionCapabilities(pools,expectedLoginPrincipals): Promise<void>` startup/readiness gate

- [ ] Write tests that reject empty URL usernames, equal usernames across any two capabilities, and malformed URLs while allowing one host/database with `runtime`, `approver`, and `safety` usernames.
- [ ] Write tests for `DATABASE_URL_FILE`, `APPROVER_DATABASE_URL_FILE`, and `SAFETY_DATABASE_URL_FILE` using an injected reader, rejecting simultaneous direct/file values and non-absolute file paths.
- [ ] Add PostgreSQL tests whose three LOGIN principals each inherit exactly one expected NOLOGIN capability; verify `current_user`, exact membership and startup success.
- [ ] Add failure cases for URL principal A authenticating as current_user B, missing expected capability, extra commercial capability and inherited elevated/group capability.
- [ ] Run `pnpm --ignore-workspace test:unit`; verify RED on missing principal/file resolution.
- [ ] Implement URL username parsing, asynchronous file resolution and live pool identity/membership queries; keep in-memory test/development behavior unchanged.
- [ ] Adapt production composition/startup through an async factory that verifies all pools before readiness while retaining a sync direct-URL constructor only for test composition.
- [ ] Run unit tests and typecheck; commit `fix: require distinct database principals`.

### Task 2: Capability memberships and default privileges

**Files:**
- Modify: `commercial-agent-swarm/runtime/migrations/002_commercial_control_plane.sql`
- Modify: `commercial-agent-swarm/runtime/integration/commercial-data-model.test.ts`

**Interfaces:**
- Consumes: four roles `commercial_runtime`, `commercial_approver`, `commercial_safety_operator`, `commercial_observer`
- Produces: migration-time role-membership audit and explicit default-function revocations

- [ ] Add PostgreSQL tests creating an unsafe privileged parent role and granting it to a capability; expect migration failure `UNSAFE_CAPABILITY_MEMBERSHIP`.
- [ ] Add tests for an inbound NOLOGIN/elevated member; expect failure, then prove a clean LOGIN principal belonging to exactly one capability survives an idempotent rerun.
- [ ] Add catalog/control/mail function creation after migration and assert PUBLIC lacks EXECUTE because of `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
- [ ] Run PostgreSQL 17 and observe the membership/default-privilege RED.
- [ ] Add catalog queries over `pg_auth_members`/`pg_roles` under the migration advisory lock; fail closed on outbound or unsafe inbound edges.
- [ ] Add the three explicit default privilege revocations and re-run PostgreSQL 17.
- [ ] Commit `fix: constrain commercial capability memberships`.

### Task 3: Append-only active catalog tuple

**Files:**
- Modify: `commercial-agent-swarm/runtime/migrations/002_commercial_control_plane.sql`
- Modify: `commercial-agent-swarm/runtime/integration/commercial-data-model.test.ts`

**Interfaces:**
- Produces: `catalog.version_activation_events`
- Produces: `mail.delivery_activation_events`
- Produces: current views used by `catalog.mission_versions_exist(...)` and `mail.delivery_policy_allows(...)`

- [ ] Test initial Proptimiza `v1/offer-v1/icp-v1/policy-v1` and delivery are current after double migration.
- [ ] Insert immutable v2 rows plus activation events; assert the v1 tuple and v1 delivery become invalid, v2 becomes valid, and inserting another later v1 activation is rejected as non-monotonic/reactivation.
- [ ] Assert UPDATE/DELETE on activation events raises the append-only exception.
- [ ] Run PostgreSQL 17 and observe RED because status/open-ended rows still define current state.
- [ ] Add activation tables with strict entity enum, referenced version identity, monotonic generation, append-only trigger and one event per generation/entity.
- [ ] Seed generation 1 events idempotently and validate complete seed rows/events.
- [ ] Replace `mission_versions_exist` and `delivery_policy_allows` queries with current-event joins; do not update version rows.
- [ ] Re-run PostgreSQL 17; commit `feat: add append-only catalog activation`.

### Task 4: Narrow migration 002 rollback

**Files:**
- Modify: `commercial-agent-swarm/runtime/migrations/002_commercial_control_plane.rollback.sql`
- Modify: `commercial-agent-swarm/runtime/integration/commercial-data-model.test.ts`

**Interfaces:**
- Produces: rollback that drops only objects created by 002, including `mail.external_actions_approval_id_idx`

- [ ] Extend rollback test with sentinel objects in `catalog`, `control`, `mail`, legacy rows, and representative 001 functions/tables; assert all survive.
- [ ] Assert every enumerated 002 table/view/function/trigger/index is absent after rollback.
- [ ] Run PostgreSQL 17 and observe RED from `DROP SCHEMA catalog CASCADE`, leaked index or lost sentinels.
- [ ] Replace schema CASCADE with dependency-ordered explicit DROP statements and explicit index removal.
- [ ] Run migration twice, rollback once and verify PostgreSQL 17 GREEN.
- [ ] Commit `fix: narrow commercial migration rollback`.

### Task 5: Database hardening gates

- [ ] Run `pnpm --ignore-workspace test`, `pnpm --ignore-workspace typecheck`, `.\scripts\test-postgres-17.ps1`, and root `pnpm --ignore-workspace run audit:commercial-swarm`.
- [ ] Run `git diff --check`, inspect grants/memberships/rollback diff and record results in the task report.
