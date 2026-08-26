# Hermes IPC Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the broker/executor process boundary over a bounded Unix socket and harden queue, child process, seed and rollback behavior.

**Architecture:** The broker owns PostgreSQL and a remote `ExecutorPort`; the executor server owns `CUSTOM_API_KEY_FILE` and Hermes but no database secrets. PostgreSQL is authoritative for clock, lease, reservations and audit; IPC has no durable queue.

**Tech Stack:** TypeScript 5.7, Node `net`/`child_process`/`fs`, JSON Schema Draft 2020-12, PostgreSQL 17, node:test.

## Global Constraints

- Frame format is `uint32be length + UTF-8 JSON`, maximum 1 MiB, one request and one response per connection.
- Socket directory is root:IPC-group `0770`; socket is `0660`; executor supplementary groups exclude IPC GID; child UID/GID is exactly 10000.
- Fixed PATH is `/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin`.
- Approved OpenCode Go configuration is immutable: base URL `https://opencode.ai/zen/go/v1`, model `deepseek-v4-flash`, no provider/model override.
- Require `Hermes timeout < IPC timeout < PostgreSQL lease`.
- No bearer/token, external network, Docker/VPS, profile, validator or infrastructure changes.
- Model output is never the accounting source for cost/tokens.

---

### Task 1: Closed instruction/evidence and response contracts

**Files:**
- Create: `commercial-agent-swarm/runtime/src/executor-contract.ts`
- Create: `commercial-agent-swarm/runtime/schemas/hermes-ipc-request.schema.json`
- Create: `commercial-agent-swarm/runtime/schemas/hermes-ipc-response.schema.json`
- Modify: `commercial-agent-swarm/runtime/src/hermes-executor.ts`
- Modify: executor/dispatcher unit tests

**Interfaces:**
- Produces: `ExecuteInput {mission_id,assignment_id,profile_id,instruction,evidence:{trust:'untrusted_data',content}}`
- Produces: `validateExecuteRequest`, `validateIpcResponse`, `buildHermesPrompt`

- [ ] Test that trusted instruction and untrusted evidence remain separate across validation and that unknown/flattened fields fail.
- [ ] Test the exact fixed prompt wrapper and prove evidence containing override text remains inside the untrusted section.
- [ ] Test that model `token_cost` is absent/ignored for accounting and that only validated Hermes usage telemetry populates usage.
- [ ] Run focused tests and observe RED; implement closed validators/wrapper; re-run GREEN.

### Task 2: Server-clock queue, reservation and rollback 003

**Files:**
- Modify: `commercial-agent-swarm/runtime/migrations/003_dispatch_queue.sql`
- Create: `commercial-agent-swarm/runtime/migrations/003_dispatch_queue.rollback.sql`
- Modify: `commercial-agent-swarm/runtime/src/dispatch-queue.ts`
- Modify: `commercial-agent-swarm/runtime/integration/dispatcher-postgres.test.ts`

**Interfaces:**
- Produces: timestamp-free queue methods `recover()`, `claim(worker,leaseSeconds)`, `fail(id,worker,code,recoverable)`, `complete(id,worker,envelope,hash,trustedUsage)`
- Produces: `abandon(id,worker)` behavior that leaves uncertain work leased

- [ ] Test that SQL function signatures reject client timestamps and server time controls lease expiry/worker CAS.
- [ ] Test pre-claim reservation of token ceiling plus `max_api_calls`, mission remaining budget, concurrent reservation exclusion, fixed currency, approved fixed execution charge and rejection before execution when monetary cost is unknown/null.
- [ ] Test IPC-uncertain abandonment leaves status leased until expiry; confirmed child termination may requeue.
- [ ] Test usage unknown cannot become succeeded and production dispatch is blocked without trusted telemetry.
- [ ] Run PostgreSQL 17 RED; implement minimal schema/functions/repository changes; re-run GREEN.
- [ ] Test rollback 003 preserves 001/002/catalog/legacy/sentinels and removes only dispatch objects; implement rollback; re-run GREEN.
- [ ] Commit `fix: make dispatch leases and budgets authoritative`.

### Task 3: Bounded Unix frame codec

**Files:**
- Create: `commercial-agent-swarm/runtime/src/unix-frame.ts`
- Create: `commercial-agent-swarm/runtime/test/unix-frame.test.ts`

**Interfaces:**
- Produces: `encodeFrame(value,maxBytes): Buffer`
- Produces: `readSingleFrame(stream,maxBytes,timeoutMs): Promise<unknown>`

- [ ] Test exact uint32be frame, zero/oversize declaration, payload over cap, truncated close, trailing bytes, invalid UTF-8/JSON and timeout.
- [ ] Run focused test and observe missing-code RED.
- [ ] Implement bounded accumulation with early destroy and one-frame completion; run GREEN.
- [ ] Commit with Task 4 after end-to-end IPC passes.

### Task 4: Unix executor client/server

**Files:**
- Create: `commercial-agent-swarm/runtime/src/unix-executor-client.ts`
- Create: `commercial-agent-swarm/runtime/src/unix-executor-server.ts`
- Create: `commercial-agent-swarm/runtime/test/unix-executor-ipc.test.ts`

**Interfaces:**
- Produces: `UnixExecutorClient implements ExecutorPort`
- Produces: `UnixExecutorServer.start()/close()`
- Consumes: frame codec and closed validators

- [ ] Test a real temporary Unix socket round trip, request-id binding, one request/connection and no auth field.
- [ ] Test malformed/oversized request never invokes executor, second simultaneous request gets `EXECUTOR_BUSY`, and client timeout destroys its connection.
- [ ] Test server socket mode `0660`, directory mode/group checks, `process.getgroups()` IPC-GID rejection and Linux UID/GID 10000 access denial (skip only when the platform cannot express Unix ownership).
- [ ] Run focused tests RED; implement sequential fail-fast server and bounded client with no retry loop.
- [ ] Map BUSY/HERMES_TIMEOUT as safe immediate retry and IPC timeout/loss as uncertain lease retention; run dispatcher tests GREEN.
- [ ] Commit `feat: isolate Hermes executor over Unix IPC`.

### Task 5: Process group and output bounds

**Files:**
- Modify: `commercial-agent-swarm/runtime/src/hermes-executor.ts`
- Modify: `commercial-agent-swarm/runtime/test/hermes-executor.test.ts`

**Interfaces:**
- Produces: `NodeProcessRunner({maxStdoutBytes,maxStderrBytes,killGroup})`

- [ ] Test stdout and stderr caps independently with an injected child/spawner; expect bounded overflow codes and no retained bytes beyond cap.
- [ ] Test timeout/overflow signals negative PGID, waits for `close`, clears timer and settles once after spawn error.
- [ ] Run RED; implement `detached:true` POSIX group leader, group kill and close-based settlement; run GREEN.

### Task 6: Seed and execution-root verification

**Files:**
- Create: `commercial-agent-swarm/runtime/src/profile-seed.ts`
- Modify: `commercial-agent-swarm/runtime/src/hermes-executor.ts`
- Modify: executor tests

**Interfaces:**
- Produces: `ProfileSeedVerifier.verify(seedPath,manifest): Promise<void>`
- Produces: `validateExecutionRoot(path): Promise<string>`
- Produces: `validateHermesUsage(value): TrustedUsage` for `-z --usage-file`

- [ ] Test relative/symlink/non-root/group-writable/world-writable seed rejection, missing/extra/changed manifest files, wrong OpenCode Go base URL/model, post-copy verification, temporary-root symlink and wrong PATH/UID/GID.
- [ ] Test the closed Hermes 0.20.1 usage schema, ranges, token totals, API call reservation, expected provider/model, known-cost relationship and `unknown/null` cost blocking.
- [ ] Run RED; implement lstat/realpath/mode/uid and SHA-256 manifest checks; run GREEN.
- [ ] Update exact invocation test to image PATH and UID/GID 10000.

### Task 7: Two container entrypoint compositions

**Files:**
- Create: `commercial-agent-swarm/runtime/src/broker-entrypoint.ts`
- Create: `commercial-agent-swarm/runtime/src/executor-entrypoint.ts`
- Create: `commercial-agent-swarm/runtime/test/runtime-entrypoints.test.ts`

**Interfaces:**
- Produces: `parseBrokerEnvironment`, `parseExecutorEnvironment`, `createBrokerRuntime`, `createExecutorRuntime`

- [ ] Test broker rejects `CUSTOM_API_KEY`, `CUSTOM_API_KEY_FILE` and executor secret prefixes while accepting PostgreSQL credentials.
- [ ] Test executor accepts only root-only `CUSTOM_API_KEY_FILE`, rejects direct key and DB/mail/Telegram/CRM/Docker/SSH name prefixes, and never scans values heuristically.
- [ ] Test timeout ordering, socket path/group, one broker replica/dispatcher concurrency and absence of the opposite capability in composed objects.
- [ ] Run RED; implement injected config/composition without starting external services; run GREEN.
- [ ] Document that replica scaling requires busy-protocol redesign.
- [ ] Commit `feat: add split commercial runtime entrypoints`.

### Task 8: Final verification

- [ ] Run `pnpm --ignore-workspace test`, `pnpm --ignore-workspace typecheck`, `.\scripts\test-postgres-17.ps1`, schema JSON parses and `pnpm --ignore-workspace run audit:commercial-swarm`.
- [ ] Run `git diff --check`, selective staging review and secret/forbidden-flag scans.
- [ ] Write the ignored task report with RED/GREEN evidence, commands, decisions and remaining non-deployable risks.
