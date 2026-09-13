# A0 behavior batch admission

`createA0BehaviorBatchAdmission` is an inert, dependency-injected capability exported from
`src/runtime-entrypoints.ts`. Importing or constructing it does not read credentials, reserve
credit, start a timer, call a model, or spawn a process. The module also exports an inert,
dependency-injected `ProtectedA0BehaviorBatchRunner`; this change intentionally provides no
command, HTTP route, scheduler, startup wiring, production authorization verifier, or credential
secret to invoke it.

`a0-batch-sealer-main` is the offline preparation boundary for that invocation. Preview mode
reconstructs the current 96-fixture/24-profile snapshot and emits one exact six-task candidate.
Seal mode accepts only a fresh gate for the candidate's displayed authorization text, verifies
the Ed25519 key pair, and writes a 124-file sealed request atomically. The authorization is
deliberately honest and single-use: it permits local persistence, sealed transfer, and exactly
one execution attempt for the named batch, capped at six model calls, 24,576 tokens, and USD
0.06. It never permits tools, real connectors, CRM writes, contact, A3, or external actions, and
it forbids retry after an uncertain outcome. The sealer itself has no network, database, provider,
transfer, dispatch, or execution port; the runtime must still perform fresh preflight and consume
the authorization exactly once.

The compiler accepts the prepared 6 x 16 source plan only together with an exact sealed artifact
snapshot. The snapshot binds all 96 fixture files and 24 profile files to byte counts, SHA-256
digests, and opaque `a0-sealed:` handles. Admission requires an injected snapshot verifier to
attest those handles before authorization or budget reservation.

Admission synchronously copies and deeply freezes the complete authorization-bearing plan before
its first asynchronous boundary. Only dense plain-JSON arrays and objects are accepted: accessors,
proxies, custom prototypes, exotic values, sparse indices, and a verifier result other than the
primitive boolean `true` fail closed. Every verifier, ledger, credential, runner, settlement, and
hold call is then derived exclusively from that stable snapshot.

One explicit admission call can target one exact six-task batch. Its dedicated contract fixes each
task to A0, 4096 tokens, one model call, one attempt, no runtime tools, no real connectors, and a
USD 0.01 reservation (1,000,000 microcents). The full plan is 96,000,000 microcents. A created
reservation always precedes credential acquisition and runner invocation. A database-authoritative,
expiry-aware execution permit is checked immediately before credential acquisition and again
immediately before spawn; denial holds the reservation and no provider process starts. An unknown
outcome is held once for manual reconciliation and is never retried by this capability.

`createA0BehaviorAuthorityAdapters` composes the optional production boundaries without enabling
them. Construction performs no database or filesystem I/O. `PostgresA0BehaviorLedger` exposes
only seven fixed PostgreSQL functions from migration 038 (reserve, batch execution permit,
task-bound execution permit, shared-budget projection, settle, one exact settlement read, and
hold) and verifies the exact
`proptimiza_a0_behavior_ledger_login` function-only principal before use. PostgreSQL cannot deny
`TEMP` to one role while `PUBLIC` retains it, so the authority is isolated in the exact marked
`proptimiza_commercial_authority` database. This database contains the complete commercial control
plane (not an A0-only copy), preserving the transactional A0/A1/budget/CRM interlocks while leaving
external runtime, CRM, n8n, postgres, template, and other database ACLs unchanged.
`scripts/bootstrap-commercial-authority-database.sql` creates only that dedicated database and its
NOLOGIN owner. After all migrations through 038, `scripts/provision-a0-behavior-ledger-principal.sql`
refuses any other database or owner, removes `PUBLIC` database access there only, and grants the
secret-free LOGIN exactly `CONNECT` plus its capability role. The idempotent
`scripts/rollback-a0-behavior-ledger-principal.sql` removes only that LOGIN and preserves the
dedicated database, migrations, capability role, isolation baseline, and sibling databases.
Authentication secrets remain a deployment-boundary responsibility.
`PosixA0ArtifactSnapshotVerifier` resolves opaque handles only below
`/run/proptimiza-a0-sealed`, reusing the root-owned, group-0440, one-link, `O_NOFOLLOW` reader and
then comparing the exact canonical snapshot bytes and every artifact byte count and SHA-256.

The protected manual runner rechecks the exact profile-bundle digest, obtains a database-bound
five-second lease for every task, reads each sealed synthetic fixture, and executes the six
profiles strictly in sequence. Each task is limited to one provider call, 4096 tokens, no tools,
no connectors, no memory, and 1,000,000 microcents. Usage is measured baseline-to-after for every
single call; duplicate, missing, oversized, ambiguous, or conflicting receipts produce an unknown
outcome and no retry. The executor receives only the opaque handle
`a0-credential:executor-managed-opencode-go-v1`; the actual provider credential remains in the
executor boundary and is read only after the A0 policy, profile seed, and task lease pass.

Task observations emitted by the optional callback are non-authoritative telemetry. They are not
durably persisted by this change and therefore cannot satisfy the 96-result promotion gate by
themselves. A future composition must add a separately reviewed immutable result sink and signed
authorization verifier before any live A0 batch can be invoked.

The append-only PostgreSQL ledger permits sixteen 6,000,000-microcent reservations per run and a
96,000,000-microcent run ceiling. It admits at most one active A0 batch globally, excludes A0 and
A1 attempts from coexisting, and counts both authorities against the shared 1,000,000,000-
microcent activation ceiling under one lock order. An expired reservation becomes
`held_unknown` and activates shared quarantine. A later exact known result supersedes only that
expiry hold with a new append-only terminal version, records exactly six immutable provider receipts,
their canonical set hash and aggregate audit evidence, and retains quarantine. Each receipt has a
unique provider ID, a positive safe-integer value, and the six values must sum to the exact batch
total; a conflict on any member rolls back the entire settlement. Usage above a batch reservation becomes
`budget_exceeded` and also activates shared quarantine. If the
settlement response is lost, admission performs one exact read, then returns the confirmed state
or `settlement_unconfirmed`; it performs no second mutation. A shared immutable receipt registry
stores each of the six records, keys provider plus usage-record ID, and binds authority, value, and
fingerprint so the same receipt
cannot be consumed across A0 and A1. Migration 038 also wraps future A1 claim, activation, and
settlement paths to enforce these shared invariants; its empty-ledger rollback restores all three
retained functions and their prior grants. None of these adapters is wired into a startup, timer,
scheduler, CLI, route, credential provider, or process runner.
