# Hermes IPC runtime design

## Scope

This change closes the local runtime trust boundary between the deterministic broker and the Hermes executor. It adds no VPS, Compose, public network, provider, mailbox or infrastructure action. The broker owns PostgreSQL and dispatch state but no inference credential. The executor owns the Hermes inference credential and process launcher but no database, mail, Telegram, CRM, Docker or SSH credential.

## Process boundary and configuration

The broker composes `PostgresDispatchQueue`, `DeterministicDispatcher` and a `UnixExecutorClient` implementing `ExecutorPort`. Its environment parser rejects `CUSTOM_API_KEY`, `CUSTOM_API_KEY_FILE` and executor-only configuration.

The executor composes `UnixExecutorServer`, `HermesExecutor`, `NodeProcessRunner` and the POSIX home ownership preparer. Its environment parser rejects database, mail, Telegram, CRM, Docker and SSH secret names and values. The inference credential is read from a root-only `CUSTOM_API_KEY_FILE`; the adapter does not require the key value in its inherited environment. The executor child receives the key as its only credential.

Both entrypoints are dependency-injected composition functions suitable for separate containers. They do not deploy or contact an external service.

## Unix socket protocol

The transport is an AF_UNIX stream socket. Its parent directory is pre-created as root and the dedicated broker/executor group with mode `0770`. The server verifies the directory is absolute, real, not a symlink and has the configured group, then creates the socket with mode `0660`. UID/GID `10000` is neither the owner nor a member of this group, so the Hermes child cannot open the socket. There is no bearer or protocol token; filesystem ownership and group ACL are the authorization boundary.

Every connection carries exactly one request and one response. Each frame is `uint32be payload_length` followed by UTF-8 JSON, with a hard maximum of 1 MiB. Zero-length, oversized, truncated, trailing, malformed or schema-invalid frames are rejected and the connection is destroyed. The request is a closed `execute` object containing a bounded request ID and the closed `ExecuteInput`. The response repeats the request ID and is exactly one of a validated success envelope or a bounded structured error. Unknown fields are rejected.

The server accepts only one active execution. A second valid request receives `EXECUTOR_BUSY` immediately and is closed. The client classifies this error as transient; the dispatcher records a recoverable failure through its existing bounded attempts, so there is no unbounded client loop or duplicate local queue. Phase one requires one broker replica and one dispatcher concurrency. Scaling replicas requires redesigning busy handling rather than relying on socket backlog behavior.

The client request timeout must be greater than the Hermes child timeout by a validated margin. This makes `HERMES_TIMEOUT`, not `EXECUTOR_BUSY` or an IPC timeout, the normal bounded execution failure. On timeout the client destroys the socket and rejects with `EXECUTOR_IPC_TIMEOUT`.

## Child process and filesystem containment

The executor accepts only UID/GID `10000`, the fixed safe path `/usr/local/bin:/usr/bin`, and an absolute, existing temporary root whose entire resolved path is not a symlink. The immutable seed remains root-owned; each copied home rejects symlinks and is transferred to UID/GID `10000`.

`NodeProcessRunner` enforces separate stdout and stderr byte caps. Crossing either cap kills the whole process group and reports a bounded overflow error without retaining further output. On POSIX it spawns the child as a detached process-group leader and signals the negative PGID on timeout or overflow, covering descendants. It resolves or rejects only after the child `close` event so the direct child is reaped and no zombie remains. Spawn errors, timeout and overflow clear timers and listeners safely.

The exact invocation remains `hermes -p <closed-profile> --cli chat -q <prompt>` with `shell: false`. No `--oneshot`, `--yolo`, `--accept-hooks`, delegation or runtime overrides are introduced. The temporary home is removed in every outcome.

## Database rollback

`003_dispatch_queue.rollback.sql` revokes and drops only migration 003 functions, trigger, dispatch event/dependency/job tables and their identity sequence through table removal. It does not drop or mutate schema objects from migrations 001 or 002. A PostgreSQL 17 test inserts sentinel rows into the non-empty legacy tables, applies 001/002/003, executes the rollback and proves the legacy rows plus representative 001/002 functions and catalog seed remain intact.

Rollback fails closed if PostgreSQL cannot drop the 003 objects cleanly. It does not delete queued work separately; deployment must verify the queue is empty before invoking it.

## Error handling and audit behavior

IPC protocol violations do not reach Hermes. Client timeout, server busy, connection loss, Hermes timeout and bounded process failures become recoverable dispatcher failures and consume the existing attempt budget. Closed-schema executor failures and malformed output remain non-recoverable. PostgreSQL continues to provide the authoritative lease, retry, kill-switch, budget and append-only state history; IPC adds no second durable queue.

Error frames and database event reasons contain bounded codes, not raw secrets, full stderr or arbitrary stack traces.

## Tests and gates

TDD cycles cover socket framing, oversized/truncated/trailing/malformed frames, schema mismatch, one request per connection, busy behavior, timeout margin, client/server secret separation, root-only key-file loading, socket modes/group exclusion and absence of auth tokens. Runner tests cover output caps, process-group kill, timeout, reaping, root/safe-path/UID/GID validation and cleanup. PostgreSQL 17 covers rollback isolation.

Final gates are runtime unit tests, runtime typecheck, PostgreSQL 17 integration tests, commercial swarm audit, schema parse and staged diff check. Tests use temporary local sockets and injected transports only; no external network or service is contacted.
