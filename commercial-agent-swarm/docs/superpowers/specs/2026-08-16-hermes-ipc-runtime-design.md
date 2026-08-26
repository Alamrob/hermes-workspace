# Hermes IPC runtime design

## Scope

This change closes the local runtime trust boundary between the deterministic broker and the Hermes executor. It adds no VPS, Compose, public network, provider, mailbox or infrastructure action. The broker owns PostgreSQL and dispatch state but no inference credential. The executor owns the Hermes inference credential and process launcher but no database, mail, Telegram, CRM, Docker or SSH credential.

## Process boundary and configuration

The broker composes `PostgresDispatchQueue`, `DeterministicDispatcher` and a `UnixExecutorClient` implementing `ExecutorPort`. Its environment parser rejects `CUSTOM_API_KEY`, `CUSTOM_API_KEY_FILE` and executor-only configuration.

The executor composes `UnixExecutorServer`, `HermesExecutor`, `NodeProcessRunner` and the POSIX home ownership preparer. Its environment parser applies a closed denylist of database, mail, Telegram, CRM, Docker and SSH secret names and prefixes; it never tries to infer secrets by inspecting values. The inference credential is read from a root-only `CUSTOM_API_KEY_FILE`; the adapter does not require the key value in its inherited environment. The executor child receives the key as its only credential through its separately constructed environment allowlist.

Both entrypoints are dependency-injected composition functions suitable for separate containers. They do not deploy or contact an external service.

## Unix socket protocol

The transport is an AF_UNIX stream socket. Its parent directory is pre-created as root and a dedicated IPC group with mode `0770`. The server verifies the directory is absolute, real, not a symlink and has the configured group, then creates the socket with mode `0660`. The root executor process is deliberately not a member of the IPC group: it uses its narrow ownership capability to assign the socket group. Startup rejects an IPC GID found in `process.getgroups()`, so the UID/GID 10000 child cannot inherit that supplementary group during spawn. A Linux integration test proves the dropped child cannot open the socket. There is no bearer or protocol token; filesystem ownership and group ACL are the authorization boundary.

Every connection carries exactly one request and one response. Each frame is `uint32be payload_length` followed by UTF-8 JSON, with a hard maximum of 1 MiB. Zero-length, oversized, truncated, trailing, malformed or schema-invalid frames are rejected and the connection is destroyed. The request is a closed `execute` object containing a bounded request ID, trusted broker instruction and separately tagged `untrusted_data` evidence. Neither the queue nor IPC flattens those fields. The executor constructs one fixed prompt wrapper that labels the instruction as authoritative and the evidence as inert data. The response repeats the request ID and is exactly one of a validated success envelope or a bounded structured error. Unknown fields are rejected.

The server accepts only one active execution. A second valid request receives `EXECUTOR_BUSY` immediately and is closed. The client classifies this error as transient; the dispatcher records a recoverable failure through its existing bounded attempts, so there is no unbounded client loop or duplicate local queue. Phase one requires one broker replica and one dispatcher concurrency. Scaling replicas requires redesigning busy handling rather than relying on socket backlog behavior.

The client request timeout must be greater than the Hermes child timeout by a validated margin, and the PostgreSQL lease must be greater than the client timeout. The broker sends that exact Hermes timeout in every closed IPC request and the executor rejects a mismatch before spawning. On a lost or timed-out IPC connection the broker leaves the job leased; server-clock lease recovery marks it terminal `usage_unknown` and conservatively retains the full reservation. `EXECUTOR_BUSY` is safe to fail/retry immediately because no child started. A `HERMES_TIMEOUT` response is sent only after process-group termination and direct-child `close`, but remains terminal `usage_unknown` because provider usage may already have occurred.

## Authoritative lease and budget accounting

Dispatch SQL accepts no client timestamps. Enqueue, claim, recovery, failure and completion use `clock_timestamp()` inside their short transaction. A claim is a single server-side lock/CAS operation and requires `Hermes timeout < IPC timeout < lease`; completion requires the same worker and a lease still live at server time.

Every job reserves bounded `maximum_tokens`, bounded `maximum_api_calls` and a USD usage-value ceiling before execution. Under the mission row lock, enqueue serializes against the signed mission ceiling; claim immediately debits the complete reservation. A confirmed pre-spawn failure releases that debit, while a timeout, lost IPC result or expired lease remains terminal `usage_unknown` and conservatively consumes the reservation. A validated completion replaces the pre-debit with actual independently calculated provider usage value and records the current OpenCode Go incremental cash cost of zero, releasing only the proven-unused balance without confusing included subscription quota with a cash charge.

Hermes 0.20.1 is invoked with its supported `-z <prompt> --usage-file <executor-controlled-path>` noninteractive path. The executor validates the closed usage JSON and independently prices trusted token counts from the dated official OpenCode Go snapshot. Before reading the API key or spawning, it rejects an expired snapshot, unpublished cache-write pricing or a reservation below worst-case output-token value. The stored snapshot identifier is mandatory; model-authored accounting fields are never authoritative.

The dated `opencode-go-2026-08-16-v1` snapshot has no published DeepSeek V4 Flash cache-write rate, so production inference remains blocked at preflight. This does not change the approved OpenCode Go endpoint or model. A reviewed replacement snapshot, or a closed and verified guarantee that cache-write tokens cannot occur, is required before the executor may read the Go key or start Hermes.

## Child process and filesystem containment

The executor accepts only UID/GID `10000`, the fixed image path `/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin`, and an absolute, existing temporary root whose entire resolved path is not a symlink. This path resolves the stock image's `/opt/hermes/.venv/bin/hermes` without a runtime override. Before every copy, the seed path must be absolute and real, owned by root, not group/world writable, contain no symlink and match an approved manifest of relative file SHA-256 values with no missing or extra files. The copied tree is verified again before it is transferred to UID/GID `10000`.

`NodeProcessRunner` enforces separate stdout and stderr byte caps. Crossing either cap kills the whole process group and reports a bounded overflow error without retaining further output. On POSIX it spawns the child as a detached process-group leader and signals the negative PGID on timeout or overflow, covering descendants. It resolves or rejects only after the child `close` event so the direct child is reaped and no zombie remains. Spawn errors, timeout and overflow clear timers and listeners safely.

The invocation is the exact path verified against the pinned Hermes 0.20.1 image: `hermes -p <closed-profile> -z <prompt> --usage-file <executor-controlled-path>` with `shell: false`. The image help exposes `-z` as the prompt flag and does not expose `-q`; neither an invented `-q` nor a separate `--cli chat` path is used. The approved seed manifest fixes OpenCode Go to base URL `https://opencode.ai/zen/go/v1` and model `deepseek-v4-flash`; the runtime accepts no provider or model override. No `--oneshot`, `--yolo`, `--accept-hooks`, delegation or other runtime overrides are introduced. The temporary home and usage file are removed in every outcome.

## Database rollback

`003_dispatch_queue.rollback.sql` revokes and drops only migration 003 functions, trigger, dispatch event/dependency/job tables and their identity sequence through table removal. It does not drop or mutate schema objects from migrations 001 or 002. A PostgreSQL 17 test inserts sentinel rows into the non-empty legacy tables, applies 001/002/003, executes the rollback and proves the legacy rows plus representative 001/002 functions and catalog seed remain intact.

Both rollback scripts fail closed before any destructive statement when their owned tables contain non-seed operational data. Migration 002 permits only its exact reproducible Proptimiza seed and no dependent mission, approval, audit, webhook or external-action state; migration 003 requires empty dispatch history. Operators must preserve and explicitly clear any such history under an approved recovery procedure before a schema downgrade.

Rollback fails closed if PostgreSQL cannot drop the 003 objects cleanly. It does not delete queued work separately; deployment must verify the queue is empty before invoking it.

## Error handling and audit behavior

IPC protocol violations do not reach Hermes. Server busy is a recoverable dispatcher failure and consumes the existing attempt budget. A confirmed Hermes timeout is terminal `usage_unknown`, because killing and reaping the process cannot prove that the provider recorded no usage. Client timeout or connection loss leaves the lease untouched until server-clock expiry, preventing a new child from starting while the first may still run. Closed-schema executor failures and malformed output remain non-recoverable. PostgreSQL continues to provide the authoritative lease, retry, kill-switch, budget and append-only state history; IPC adds no second durable queue.

Error frames and database event reasons contain bounded codes, not raw secrets, full stderr or arbitrary stack traces.

## Tests and gates

TDD cycles cover socket framing, oversized/truncated/trailing/malformed frames, schema mismatch, trusted instruction versus untrusted evidence, one request per connection, busy behavior, timeout margin, uncertain-IPC lease handling, client/server secret separation, root-only key-file loading, socket modes/group exclusion and absence of auth tokens. Runner tests cover output caps, process-group kill, timeout, reaping, root/safe-path/UID/GID validation, seed manifest verification and cleanup. PostgreSQL 17 covers server-clock leases, exact worker CAS, reservation-before-execution, unknown usage blocking and rollback isolation.

Final gates are runtime unit tests, runtime typecheck, PostgreSQL 17 integration tests, commercial swarm audit, schema parse and staged diff check. Tests use temporary local sockets and injected transports only; no external network or service is contacted.

## Task 4 hardening included in the reopening

Production database composition parses the PostgreSQL login-principal username from dedicated URLs. Runtime, work-order ingestor, approver and safety usernames must be present and pairwise distinct; sharing host and database remains valid. Before readiness, each pool queries `current_user`, effective membership, relation/sequence/schema/database privileges and role attributes: the authenticated login must equal its configured username and inherit exactly its one expected NOLOGIN capability. A URL naming principal A that authenticates as principal B fails startup. The runtime capability cannot persist work orders; only the dedicated ingestor can call the structurally validating `save_mission` function after application-level signature verification.

Capability roles remain `NOLOGIN` and may not inherit another role. Migration fails closed on every outbound membership and on inbound membership that is not a clean, non-privileged `LOGIN` principal belonging to exactly one commercial capability and no other role. This permits idempotent reruns after an operator explicitly grants one capability to a dedicated login principal while rejecting privilege inherited through group or elevated roles. Those explicit login grants are deployment state and must be documented and rechecked by preflight. Default privileges explicitly revoke public function execution in `catalog`, `control` and `mail`.

Catalog activation is append-only. Project, project version, offer, ICP, policy and delivery activation events define current views without updating immutable catalog rows. `mission_versions_exist` accepts only one tuple whose complete chain is currently active. Activating a later policy or delivery version closes the previous current view through event ordering, so an open-ended `policy-v1` cannot become current again implicitly.

Migration 002 rollback enumerates and removes only 002-owned views, functions, triggers, tables and indexes, including `external_actions_approval_id_idx`. It never uses `DROP SCHEMA catalog CASCADE`. PostgreSQL 17 tests prove preservation of 001, legacy rows, schemas and unrelated sentinel objects.
